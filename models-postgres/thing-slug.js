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

// You can use these slugs, but they'll be automatically be qualified with a number
const reservedSlugs = ['register', 'actions', 'signin', 'login', 'teams', 'user', 'new', 'signout', 'logout', 'api', 'faq', 'static', 'terms'];

class ThingSlug {
  constructor(data = {}) {
    this.name = data.name;
    // Handle both camelCase and snake_case input for compatibility
    this.baseName = data.baseName || data.base_name;
    this.qualifierPart = data.qualifierPart || data.qualifier_part;
    this.thingID = data.thingID || data.thing_id;
    this.createdOn = data.createdOn || data.created_on || new Date();
    this.createdBy = data.createdBy || data.created_by;
  }

  static async create(data) {
    const dal = await getPostgresDAL();
    const slug = new ThingSlug(data);
    
    const result = await dal.query(`
      INSERT INTO thing_slugs (name, base_name, qualifier_part, thing_id, created_on, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [slug.name, slug.baseName, slug.qualifierPart, slug.thingID, slug.createdOn, slug.createdBy]);
    
    return new ThingSlug(result.rows[0]);
  }

  static async get(name) {
    const dal = await getPostgresDAL();
    const result = await dal.query(`
      SELECT * FROM thing_slugs WHERE name = $1
    `, [name]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return new ThingSlug(result.rows[0]);
  }

  static async filter(criteria) {
    const dal = await getPostgresDAL();
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (criteria.baseName) {
      whereClause += ` AND base_name = $${paramIndex}`;
      params.push(criteria.baseName);
      paramIndex++;
    }

    if (criteria.thingID) {
      whereClause += ` AND thing_id = $${paramIndex}`;
      params.push(criteria.thingID);
      paramIndex++;
    }

    const result = await dal.query(`
      SELECT * FROM thing_slugs ${whereClause}
      ORDER BY created_on DESC
    `, params);
    
    return result.rows.map(row => new ThingSlug(row));
  }

  async save() {
    const dal = await getPostgresDAL();
    
    try {
      const result = await dal.query(`
        INSERT INTO thing_slugs (name, base_name, qualifier_part, thing_id, created_on, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO UPDATE SET
          base_name = EXCLUDED.base_name,
          qualifier_part = EXCLUDED.qualifier_part,
          thing_id = EXCLUDED.thing_id,
          created_on = EXCLUDED.created_on,
          created_by = EXCLUDED.created_by
        RETURNING *
      `, [this.name, this.baseName, this.qualifierPart, this.thingID, this.createdOn, this.createdBy]);
      
      Object.assign(this, result.rows[0]);
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