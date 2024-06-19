import _ from 'lodash';
import delegate from 'delegates';
import { errors as databaseErrors } from '@strapi/database';
import {
  contentTypes as contentTypesUtils,
  sanitize,
  errors,
  relations as relationUtils,
  convertQueryParams,
} from '@strapi/utils';
import type { Database } from '@strapi/database';
import type {
  Strapi,
  EntityService,
  EntityValidator,
  EventHub,
  Common,
  Schema,
  Shared,
  Utils,
} from '@strapi/types';

import uploadFiles from '../utils/upload-files';

import {
  omitComponentData,
  getComponents,
  createComponents,
  updateComponents,
  deleteComponents,
  cloneComponents,
} from './components';

import { pickSelectionParams } from './params';
import { applyTransforms } from './attributes';

const { transformParamsToQuery } = convertQueryParams;

type Decoratable<T> = T & {
  decorate(
    decorator: (old: EntityService.EntityService) => EntityService.EntityService & {
      [key: string]: unknown;
    }
  ): void;
};

type Context = {
  contentType: Schema.ContentType;
};

const transformLoadParamsToQuery = (
  uid: string,
  field: string,
  params: Record<string, unknown>,
  pagination = {}
) => {
  const query = transformParamsToQuery(uid, { populate: { [field]: params } as any }) as any;

  const res = {
    ...query.populate[field],
    ...pagination,
  };

  return res;
};

const databaseErrorsToTransform = [
  databaseErrors.InvalidTimeError,
  databaseErrors.InvalidDateTimeError,
  databaseErrors.InvalidDateError,
  databaseErrors.InvalidRelationError,
];

const creationPipeline = (data: Record<string, unknown>, context: Context) => {
  return applyTransforms(data, context);
};

const updatePipeline = (data: Record<string, unknown>, context: Context) => {
  return applyTransforms(data, context);
};

const ALLOWED_WEBHOOK_EVENTS = {
  ENTRY_CREATE: 'entry.create',
  ENTRY_UPDATE: 'entry.update',
  ENTRY_DELETE: 'entry.delete',
};

const getMediaPopulate = (uid: Common.UID.Schema) => {
  const model = strapi.getModel(uid);
  const attributes = Object.entries(model.attributes);

  return attributes.reduce((acc: any, [attributeName, attribute]) => {
    switch (attribute.type) {
      case 'media': {
        acc[attributeName] = true;
        return acc;
      }
      case 'component': {
        const populate = getMediaPopulate(attribute.component);
        acc[attributeName] = { populate };
        return acc;
      }
      case 'dynamiczone': {
        // Use fragments to populate the dynamic zone components
        const populatedComponents = (attribute.components || []).reduce(
          (acc: any, componentUID: Common.UID.Component) => {
            acc[componentUID] = { populate: getMediaPopulate(componentUID) };
            return acc;
          },
          {}
        );

        acc[attributeName] = { on: populatedComponents };
        break;
      }
      default:
        break;
    }

    return acc;
  }, {});
};

const createDefaultImplementation = ({
  strapi,
  db,
  eventHub,
  entityValidator,
}: {
  strapi: Strapi;
  db: Database;
  eventHub: EventHub;
  entityValidator: EntityValidator;
}): EntityService.EntityService => ({
  /**
   * Upload files utility
   */
  uploadFiles,

  async wrapParams(options: any = {}) {
    return options;
  },

  async wrapResult(result: any = {}) {
    return result;
  },

  async emitEvent(uid, event: string, entity) {
    // Ignore audit log events to prevent infinite loops
    if (uid === ('admin::audit-log' as Common.UID.ContentType)) {
      return;
    }

    const model = strapi.getModel(uid);
    const sanitizedEntity = await sanitize.sanitizers.defaultSanitizeOutput(model, entity);

    eventHub.emit(event, {
      model: model.modelName,
      uid: model.uid,
      entry: sanitizedEntity,
    });
  },

  async findMany(uid, opts) {
    const { kind } = strapi.getModel(uid);

    const wrappedParams = await this.wrapParams(opts, { uid, action: 'findMany' });

    const query = transformParamsToQuery(uid, wrappedParams);

    if (kind === 'singleType') {
      const entity = db.query(uid).findOne(query);
      return this.wrapResult(entity, { uid, action: 'findOne' });
    }

    const entities = await db.query(uid).findMany(query);
    return this.wrapResult(entities, { uid, action: 'findMany' });
  },

  async findPage(uid, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'findPage' });

    const query = transformParamsToQuery(uid, wrappedParams);

    const page = await db.query(uid).findPage(query);
    return {
      ...page,
      results: await this.wrapResult(page.results, { uid, action: 'findPage' }),
    };
  },

  // TODO: streamline the logic based on the populate option
  async findWithRelationCountsPage(uid, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'findWithRelationCounts' });

    const query = transformParamsToQuery(uid, wrappedParams);

    const entities = await db.query(uid).findPage(query);
    return {
      ...entities,
      results: await this.wrapResult(entities.results, { uid, action: 'findWithRelationCounts' }),
    };
  },

  async findWithRelationCounts(uid, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'findWithRelationCounts' });

    const query = transformParamsToQuery(uid, wrappedParams);

    const entities = await db.query(uid).findMany(query);
    return this.wrapResult(entities, { uid, action: 'findWithRelationCounts' });
  },

  async findOne(uid, entityId, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'findOne' });

    const query = transformParamsToQuery(uid, pickSelectionParams(wrappedParams));

    const entity = await db.query(uid).findOne({ ...query, where: { id: entityId } });
    return this.wrapResult(entity, { uid, action: 'findOne' });
  },

  async count(uid, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'count' });

    const query = transformParamsToQuery(uid, wrappedParams);

    return db.query(uid).count(query);
  },

  async create<
    TUID extends Common.UID.ContentType,
    TParams extends EntityService.Params.Pick<TUID, 'data' | 'files' | 'fields' | 'populate'>
  >(uid: TUID, params?: TParams) {
    const wrappedParams = await this.wrapParams<TParams>(params, { uid, action: 'create' });
    const { data, files } = wrappedParams;

    if (!data) {
      throw new Error('cannot create');
    }

    const model = strapi.getModel(uid) as Shared.ContentTypes[Common.UID.ContentType];

    const isDraft = contentTypesUtils.isDraft(data, model);
    const validData = await entityValidator.validateEntityCreation(model, data, { isDraft });

    // select / populate
    const query = transformParamsToQuery(uid, pickSelectionParams(wrappedParams));

    // TODO: wrap into transaction
    const componentData = await createComponents(uid, validData);

    const entityData = creationPipeline(
      Object.assign(omitComponentData(model, validData), componentData),
      {
        contentType: model,
      }
    );
    let entity = await db.query(uid).create({
      ...query,
      data: entityData,
    });

    // TODO: do all of this in a transaction to avoid a race condition where entity is created then deleted before we do findOne again
    // TODO: upload the files then set the links in the entity like with compo to avoid making too many queries
    if (files && Object.keys(files).length > 0) {
      await this.uploadFiles(uid, Object.assign(entityData, entity), files);
      entity = await this.findOne(uid, entity.id, wrappedParams);
    }

    entity = await this.wrapResult(entity, { uid, action: 'create' });

    const { ENTRY_CREATE } = ALLOWED_WEBHOOK_EVENTS;
    await this.emitEvent(uid, ENTRY_CREATE, entity);

    return entity;
  },

  async update(uid, entityId, opts) {
    const wrappedParams = await this.wrapParams<
      EntityService.Params.Pick<typeof uid, 'data:partial' | 'files' | 'fields' | 'populate'>
    >(opts, {
      uid,
      action: 'update',
    });
    const { data, files } = wrappedParams;

    const model = strapi.getModel(uid);

    const entityToUpdate = await db.query(uid).findOne({ where: { id: entityId } });

    if (!entityToUpdate) {
      return null;
    }

    const isDraft = contentTypesUtils.isDraft(entityToUpdate, model);

    const validData = await entityValidator.validateEntityUpdate(
      model,
      data,
      {
        isDraft,
      },
      entityToUpdate
    );

    const query = transformParamsToQuery(uid, pickSelectionParams(wrappedParams));

    // TODO: wrap in transaction
    const componentData = await updateComponents(uid, entityToUpdate, validData);
    const entityData = updatePipeline(
      Object.assign(omitComponentData(model, validData), componentData),
      { contentType: model }
    );

    let entity = await db.query(uid).update({
      ...query,
      where: { id: entityId },
      data: entityData,
    });

    // TODO: upload the files then set the links in the entity like with compo to avoid making too many queries
    if (files && Object.keys(files).length > 0) {
      await this.uploadFiles(uid, Object.assign(entityData, entity), files);
      entity = await this.findOne(uid, entity.id, wrappedParams);
    }

    entity = await this.wrapResult(entity, { uid, action: 'update' });

    const { ENTRY_UPDATE } = ALLOWED_WEBHOOK_EVENTS;
    await this.emitEvent(uid, ENTRY_UPDATE, entity);

    return entity;
  },

  async delete(uid, entityId, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'delete' });

    // select / populate
    const query = transformParamsToQuery(uid, pickSelectionParams(wrappedParams));

    let entityToDelete = await db.query(uid).findOne({
      ...query,
      where: { id: entityId },
    });

    if (!entityToDelete) {
      return null;
    }

    const componentsToDelete = await getComponents(uid, entityToDelete);

    await db.query(uid).delete({ where: { id: entityToDelete.id } });
    await deleteComponents(uid, componentsToDelete as any, { loadComponents: false });

    entityToDelete = await this.wrapResult(entityToDelete, { uid, action: 'delete' });

    const { ENTRY_DELETE } = ALLOWED_WEBHOOK_EVENTS;
    await this.emitEvent(uid, ENTRY_DELETE, entityToDelete);

    return entityToDelete;
  },

  async clone(uid, cloneId, opts) {
    const wrappedParams = await this.wrapParams<
      EntityService.Params.Pick<typeof uid, 'data' | 'files' | 'fields' | 'populate'>
    >(opts, { uid, action: 'clone' });
    const { data, files } = wrappedParams;

    if (!data) {
      throw new Error('cannot clone');
    }

    const model = strapi.getModel(uid);

    /**
     * Media attributes are not automatically cloned in the db layer,
     * this populate ensures media is cloned in case user does not provide
     * any override value
     */
    const populate = getMediaPopulate(uid);

    const entityToClone = await db.query(uid).findOne({
      where: { id: cloneId },
      populate,
    });

    if (!entityToClone) {
      return null;
    }
    const isDraft = contentTypesUtils.isDraft(entityToClone, model);

    const validData = await entityValidator.validateEntityUpdate(
      model,
      // Omit the id, the cloned entity id will be generated by the database
      _.omit(_.merge(entityToClone, data), ['id']) as Partial<typeof data>,
      { isDraft },
      entityToClone
    );
    const query = transformParamsToQuery(uid, pickSelectionParams(wrappedParams));

    // TODO: wrap into transaction
    const componentData = await cloneComponents(uid, entityToClone, validData);

    const entityData = creationPipeline(
      Object.assign(omitComponentData(model, validData), componentData),
      {
        contentType: model,
      }
    );

    let entity = await db.query(uid).clone(cloneId, {
      ...query,
      data: entityData,
    });

    // TODO: upload the files then set the links in the entity like with compo to avoid making too many queries
    if (files && Object.keys(files).length > 0) {
      await this.uploadFiles(uid, Object.assign(entityData, entity), files);
      entity = await this.findOne(uid, entity.id, wrappedParams);
    }

    const { ENTRY_CREATE } = ALLOWED_WEBHOOK_EVENTS;
    await this.emitEvent(uid, ENTRY_CREATE, entity);

    return entity;
  },
  // FIXME: used only for the CM to be removed
  async deleteMany(uid, opts) {
    const wrappedParams = await this.wrapParams(opts, { uid, action: 'delete' });

    // select / populate
    const query = transformParamsToQuery(uid, wrappedParams);

    let entitiesToDelete = await db.query(uid).findMany(query);

    if (!entitiesToDelete.length) {
      return { count: 0 };
    }

    const componentsToDelete = await Promise.all(
      entitiesToDelete.map((entityToDelete) => getComponents(uid, entityToDelete))
    );

    const deletedEntities = await db.query(uid).deleteMany(query);
    await Promise.all(
      componentsToDelete.map((compos) =>
        deleteComponents(uid, compos as any, { loadComponents: false })
      )
    );

    entitiesToDelete = await this.wrapResult(entitiesToDelete, { uid, action: 'delete' });

    // Trigger webhooks. One for each entity
    const { ENTRY_DELETE } = ALLOWED_WEBHOOK_EVENTS;
    await Promise.all(entitiesToDelete.map((entity) => this.emitEvent(uid, ENTRY_DELETE, entity)));

    return deletedEntities;
  },

  async load(uid, entity, field, params) {
    if (!_.isString(field)) {
      throw new Error(`Invalid load. Expected "${field}" to be a string`);
    }

    const loadedEntity = await db
      .query(uid)
      .load(entity, field, transformLoadParamsToQuery(uid, field, params ?? {}));

    return this.wrapResult(loadedEntity, { uid, field, action: 'load' });
  },

  async loadPages(uid, entity, field, params, pagination = {}) {
    if (!_.isString(field)) {
      throw new Error(`Invalid load. Expected "${field}" to be a string`);
    }

    const { attributes } = strapi.getModel(uid);
    const attribute = attributes[field];

    if (!relationUtils.isAnyToMany(attribute)) {
      throw new Error(`Invalid load. Expected "${field}" to be an anyToMany relational attribute`);
    }

    const query = transformLoadParamsToQuery(uid, field, params ?? {}, pagination);

    const loadedPage = await db.query(uid).loadPages(entity, field, query);

    return {
      ...loadedPage,
      results: await this.wrapResult(loadedPage.results, { uid, field, action: 'load' }),
    };
  },
});

export default (ctx: {
  strapi: Strapi;
  db: Database;
  eventHub: EventHub;
  entityValidator: EntityValidator;
}): Decoratable<EntityService.EntityService> => {
  Object.entries(ALLOWED_WEBHOOK_EVENTS).forEach(([key, value]) => {
    ctx.strapi.webhookStore?.addAllowedEvent(key, value);
  });

  const implementation = createDefaultImplementation(ctx);

  const service = {
    implementation,
    decorate<T extends object>(decorator: (current: typeof implementation) => T) {
      if (typeof decorator !== 'function') {
        throw new Error(`Decorator must be a function, received ${typeof decorator}`);
      }

      this.implementation = { ...this.implementation, ...decorator(this.implementation) };
      return this;
    },
  };

  const delegator = delegate(service, 'implementation');

  // delegate every method in implementation
  Object.keys(service.implementation).forEach((key) => delegator.method(key));

  // wrap methods to handle Database Errors
  service.decorate((oldService: EntityService.EntityService) => {
    const newService = _.mapValues(
      oldService,
      (method, methodName: keyof EntityService.EntityService) =>
        async function (this: EntityService.EntityService, ...args: []) {
          try {
            return await (oldService[methodName] as Utils.Function.AnyPromise).call(this, ...args);
          } catch (error) {
            if (
              databaseErrorsToTransform.some(
                (errorToTransform) => error instanceof errorToTransform
              )
            ) {
              if (error instanceof Error) {
                throw new errors.ValidationError(error.message);
              }

              throw error;
            }
            throw error;
          }
        }
    );

    return newService;
  });

  return service as unknown as Decoratable<EntityService.EntityService>;
};
