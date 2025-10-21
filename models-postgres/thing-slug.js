'use strict';

/**
 * PostgreSQL model for short human-readable identifiers used in URLs pointing to review
 * subjects (Thing objects). 
 *
 * This model is not versioned.
 *
 * @namespace ThingSlug
 */

const { getPostgresDAL } = require('../db-postgres');
const ModelHelper = require('./model-helper');

// You can use these slugs, but they'll be automatically be qualified with a number
const reservedSlugs = ['register', 'actions', 'signin', 'login', 'teams', 'user', 'new', 'signout', 'logout', 'api', 'faq', 'static', 'terms'];

class ThingSlug extends ModelHelper {

  static get columnMappings() {
    return {
      name: 'name',
      baseName: 'base_name',
      qualifierPart: 'qualifier_part',
      thingID: 'thing_id',
      createdOn: 'created_on',
      createdBy: 'created_by'
    };
  }

  constructor(data = {}) {
    super();
    const normalized = ThingSlug.normalizeData(data);

    this.name = normalized.name;
    this.baseName = normalized.baseName;
    this.qualifierPart = normalized.qualifierPart;
    this.thingID = normalized.thingID;
    this.createdOn = normalized.createdOn || new Date();
    this.createdBy = normalized.createdBy;
  }

  static async create(data) {
    const dal = await getPostgresDAL();
    const slug = new ThingSlug(data);
    const insertProps = ['name', 'baseName', 'qualifierPart', 'thingID', 'createdOn', 'createdBy'];
    const columnList = insertProps
      .map(property => ThingSlug.getColumnName(property))
      .join(', ');
    
    const result = await dal.query(`
      INSERT INTO thing_slugs (${columnList})
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${ThingSlug.getSelectColumns()}
    `, ThingSlug.mapValues(slug, insertProps));
    
    return new ThingSlug(result.rows[0]);
  }

  static async get(name) {
    const dal = await getPostgresDAL();
    const result = await dal.query(`
      SELECT ${ThingSlug.getSelectColumns()} FROM thing_slugs WHERE name = $1
    `, [name]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return new ThingSlug(result.rows[0]);
  }

  static async filter(criteria) {
    const dal = await getPostgresDAL();
    const clauses = ['1=1'];
    const params = [];
    let paramIndex = 1;

    if (criteria.baseName) {
      clauses.push(`${ThingSlug.getColumnName('baseName')} = $${paramIndex}`);
      params.push(criteria.baseName);
      paramIndex++;
    }

    if (criteria.thingID) {
      clauses.push(`${ThingSlug.getColumnName('thingID')} = $${paramIndex}`);
      params.push(criteria.thingID);
      paramIndex++;
    }

    const result = await dal.query(`
      SELECT ${ThingSlug.getSelectColumns()} FROM thing_slugs
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${ThingSlug.getColumnName('createdOn')} DESC
    `, params);
    
    return result.rows.map(row => new ThingSlug(row));
  }

  async save() {
    const dal = await getPostgresDAL();
    const insertProps = ['name', 'baseName', 'qualifierPart', 'thingID', 'createdOn', 'createdBy'];
    const columnList = insertProps
      .map(property => ThingSlug.getColumnName(property))
      .join(', ');
    const baseNameColumn = ThingSlug.getColumnName('baseName');
    const qualifierColumn = ThingSlug.getColumnName('qualifierPart');
    const thingIdColumn = ThingSlug.getColumnName('thingID');
    const createdOnColumn = ThingSlug.getColumnName('createdOn');
    const createdByColumn = ThingSlug.getColumnName('createdBy');
    
    try {
      const result = await dal.query(`
        INSERT INTO thing_slugs (${columnList})
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO UPDATE SET
          ${baseNameColumn} = EXCLUDED.${baseNameColumn},
          ${qualifierColumn} = EXCLUDED.${qualifierColumn},
          ${thingIdColumn} = EXCLUDED.${thingIdColumn},
          ${createdOnColumn} = EXCLUDED.${createdOnColumn},
          ${createdByColumn} = EXCLUDED.${createdByColumn}
        RETURNING ${ThingSlug.getSelectColumns()}
      `, ThingSlug.mapValues(this, insertProps));
      
      Object.assign(this, ThingSlug.normalizeData(result.rows[0]));
      return this;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Save a slug update, adding a numeric qualifier if necessary because we
   * already have a slug pointing to a different thing.
   *
   * @returns {ThingSlug}
   *  the slug that should be associated with the Thing object.
   * @memberof ThingSlug
   * @instance
   */
  async qualifiedSave() {
    this.baseName = this.name; // Store base name for later reference
    
    if (reservedSlugs.indexOf(this.name.toLowerCase()) !== -1) {
      return await this._resolveConflicts(); // saves new slug if needed
    }

    try {
      return await this.save();
    } catch (error) {
      if (error.code === '23505') { // PostgreSQL unique constraint violation
        return await this._resolveConflicts(); // saves new slug if needed
      } else {
        throw error;
      }
    }
  }

  /**
   * Resolves naming conflicts by creating a new slug with a numeric qualifier
   * if needed.
   *
   * @memberof ThingSlug
   * @returns {ThingSlug}
   *  the best available slug to use
   * @inner
   * @protected
   */
  async _resolveConflicts() {
    // Check first if we've used this base name before for the same target
    let slugs = await ThingSlug.filter({
      baseName: this.name,
      thingID: this.thingID
    });

    if (slugs.length) {
      return slugs[0]; // Got a match, no need to save -- just re-use :)
    }

    // Widen search for most recent use of this base name
    slugs = await ThingSlug.filter({
      baseName: this.name
    });

    let latestQualifierStr;
    if (slugs.length && !isNaN(+slugs[0].qualifierPart)) {
      latestQualifierStr = String(+slugs[0].qualifierPart + 1);
    } else {
      latestQualifierStr = '2';
    }
    
    this.name = `${this.name}-${latestQualifierStr}`;
    this.qualifierPart = latestQualifierStr;
    return await this.save();
  }
}

module.exports = ThingSlug;
