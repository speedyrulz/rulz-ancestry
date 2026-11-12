export { getSqliteInfo, openDatabase, type Db, type SqliteInfo } from './connection';
export { SchemaTooNewError, migrate, schemaVersion, type Migration } from './migrate';
export { treeMigrations } from './schema';
export { UNTRACKED_WRITE_MESSAGE, type ChangeTx } from './changelog';
export {
  NotATreeError,
  NotFoundError,
  TREE_APPLICATION_ID,
  TREE_FILE_NAME,
  Tree,
  TreeRuleError,
  openTree,
  type OpenTreeOptions,
  type TreeInfo,
} from './tree';
export {
  addName,
  countPersons,
  createPerson,
  deleteName,
  deletePerson,
  getPerson,
  listNames,
  requirePerson,
  setPrimaryName,
  updateName,
  updatePerson,
  type NameInput,
  type NewPerson,
  type Person,
  type PersonName,
} from './persons';
export {
  addChild,
  createFamily,
  deleteFamily,
  getChildIds,
  getFamily,
  getParents,
  isSelfOrAncestor,
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  removeChild,
  requireFamily,
  setPartners,
  type Family,
  type FamilyChild,
  type ParentLink,
} from './families';
export {
  addFamilyEvent,
  addPersonEvent,
  deleteEvent,
  getEvent,
  listFamilyEvents,
  listPersonEvents,
  requireEvent,
  updateEvent,
  type EventInput,
  type TreeEvent,
} from './events';
export {
  getPersonSummary,
  listPersons,
  searchPersons,
  toFtsQuery,
  type PageOptions,
  type PersonSummary,
} from './search';
export { checkTreeEngine, type TreeEngineCheck } from './selfcheck';
