'use strict';

/**
 * PostgreSQL model for storing short human-readable identifier (slugs) for a given team
 * 
 * @namespace TeamSlug
 */

const { getPostgresDAL } = require('../db-postgres');

class TeamSlug {
  constructor(data = {}) {
    this.name = data.name;
    this.teamID = data.teamID;
    this.createdOn = data.createdOn || new Date();
    this.createdBy = data.createdBy;
  }

  static async create(data) {
    const dal = await getPostgresDAL();
    const slug = new TeamSlug(data);
    
    const result = await dal.query(`
      INSERT INTO team_slugs (name, team_id, created_on, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [slug.name, slug.teamID, slug.createdOn, slug.createdBy]);
    
    return new TeamSlug(result.rows[0]);
  }

  static async get(name) {
    const dal = await getPostgresDAL();
    const result = await dal.query(`
      SELECT * FROM team_slugs WHERE name = $1
    `, [name]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return new TeamSlug(result.rows[0]);
  }

  async save() {
    const dal = await getPostgresDAL();
    
    try {
      const result = await dal.query(`
        INSERT INTO team_slugs (name, team_id, created_on, created_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE SET
          team_id = EXCLUDED.team_id,
          created_on = EXCLUDED.created_on,
          created_by = EXCLUDED.created_by
        RETURNING *
      `, [this.name, this.teamID, this.createdOn, this.createdBy]);
      
      Object.assign(this, result.rows[0]);
      return this;
    } catch (error) {
      throw error;
    }
  }

  // Team slugs must be unique (i.e. we don't do the bla-2, bla-3 modification
  // we do for review subjects), so a qualified save is just a regular save.
  async qualifiedSave() {
    return this.save();
  }
}

module.exports = TeamSlug;