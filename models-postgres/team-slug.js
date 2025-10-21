'use strict';

/**
 * PostgreSQL representation of a team's human-readable identifier (slug).
 *
 * This is intentionally lighter than the full DAL-backed models, but it still
 * follows the same camelCase↔snake_case mapping conventions.
 *
 * @namespace TeamSlug
 */

const { getPostgresDAL } = require('../db-postgres');
const ModelHelper = require('./model-helper');

class TeamSlug extends ModelHelper {
  static get columnMappings() {
    return {
      name: 'name',
      teamID: 'team_id',
      createdOn: 'created_on',
      createdBy: 'created_by'
    };
  }

  constructor(data = {}) {
    super();
    const normalized = TeamSlug.normalizeData(data);

    this.name = normalized.name;
    this.teamID = normalized.teamID;
    this.createdOn = normalized.createdOn || new Date();
    this.createdBy = normalized.createdBy;
  }

  static async create(data) {
    const dal = await getPostgresDAL();
    const slug = new TeamSlug(data);
    const insertProps = ['name', 'teamID', 'createdOn', 'createdBy'];
    const columnList = insertProps
      .map(property => TeamSlug.getColumnName(property))
      .join(', ');
    
    const result = await dal.query(`
      INSERT INTO team_slugs (${columnList})
      VALUES ($1, $2, $3, $4)
      RETURNING ${TeamSlug.getSelectColumns()}
    `, TeamSlug.mapValues(slug, insertProps));
    
    return new TeamSlug(result.rows[0]);
  }

  static async get(name) {
    const dal = await getPostgresDAL();
    const result = await dal.query(`
      SELECT ${TeamSlug.getSelectColumns()}
      FROM team_slugs
      WHERE name = $1
    `, [name]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return new TeamSlug(result.rows[0]);
  }

  async save() {
    const dal = await getPostgresDAL();
    const insertProps = ['name', 'teamID', 'createdOn', 'createdBy'];
    const columnList = insertProps
      .map(property => TeamSlug.getColumnName(property))
      .join(', ');
    const teamIDColumn = TeamSlug.getColumnName('teamID');
    const createdOnColumn = TeamSlug.getColumnName('createdOn');
    const createdByColumn = TeamSlug.getColumnName('createdBy');
    
    try {
      const result = await dal.query(`
        INSERT INTO team_slugs (${columnList})
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE SET
          ${teamIDColumn} = EXCLUDED.${teamIDColumn},
          ${createdOnColumn} = EXCLUDED.${createdOnColumn},
          ${createdByColumn} = EXCLUDED.${createdByColumn}
        RETURNING ${TeamSlug.getSelectColumns()}
      `, TeamSlug.mapValues(this, insertProps));
      
      Object.assign(this, TeamSlug.normalizeData(result.rows[0]));
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
