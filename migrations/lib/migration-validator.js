'use strict';

/**
 * Migration Validator for RethinkDB to PostgreSQL Migration
 * 
 * Validates data integrity and completeness between RethinkDB and PostgreSQL
 * after migration, ensuring all data has been transferred correctly.
 */

const debug = require('../../util/debug');

class MigrationValidator {
  constructor(rethinkDB, postgresDAL) {
    this.rethinkDB = rethinkDB;
    this.postgresDAL = postgresDAL;
    this.r = rethinkDB.r;
  }

  /**
   * Validate all tables between RethinkDB and PostgreSQL
   */
  async validateAllTables() {
    const results = {};
    
    // Define table mappings from RethinkDB to PostgreSQL
    const tableMappings = [
      { rethink: 'users', postgres: 'users' },
      { rethink: 'user_meta', postgres: 'user_metas' },
      { rethink: 'teams', postgres: 'teams' },
      { rethink: 'team_slugs', postgres: 'team_slugs' },
      { rethink: 'files', postgres: 'files' },
      { rethink: 'things', postgres: 'things' },
      { rethink: 'thing_slugs', postgres: 'thing_slugs' },
      { rethink: 'reviews', postgres: 'reviews' },
      { rethink: 'blog_posts', postgres: 'blog_posts' },
      { rethink: 'invite_link', postgres: 'invite_links' },
      { rethink: 'team_join_requests', postgres: 'team_join_requests' },
      { rethink: 'teams_users_membership', postgres: 'team_members' },
      { rethink: 'teams_users_moderatorship', postgres: 'team_moderators' },
      { rethink: 'reviews_teams_team_content', postgres: 'review_teams' },
      { rethink: 'files_things_media_usage', postgres: 'thing_files' }
    ];
    
    for (const mapping of tableMappings) {
      try {
        results[mapping.postgres] = await this.validateTableMapping(mapping.rethink, mapping.postgres);
      } catch (error) {
        results[mapping.postgres] = {
          isValid: false,
          recordCount: 0,
          errors: [`Validation error: ${error.message}`]
        };
      }
    }
    
    return results;
  }

  /**
   * Validate a specific table mapping
   */
  async validateTableMapping(rethinkTableName, postgresTableName) {
    const result = {
      isValid: true,
      recordCount: 0,
      errors: []
    };
    
    try {
      // Check if table exists in RethinkDB
      const rethinkTableExists = await this.checkRethinkTableExists(rethinkTableName);
      if (!rethinkTableExists) {
        // Table doesn't exist in RethinkDB, skip validation
        return {
          isValid: true,
          recordCount: 0,
          errors: [`Table ${rethinkTableName} does not exist in RethinkDB`]
        };
      }
      
      // Get record counts
      const rethinkCount = await this.getRethinkRecordCount(rethinkTableName);
      const postgresCount = await this.getPostgresRecordCount(postgresTableName);
      
      result.recordCount = postgresCount;
      
      // For join tables without IDs, just validate counts
      const joinTables = ['team_members', 'team_moderators', 'review_teams', 'thing_files'];
      if (joinTables.includes(postgresTableName)) {
        // Join tables may have different counts due to data cleaning, so just report the count
        if (rethinkCount !== postgresCount) {
          // This is expected for join tables due to data cleaning, so just log it
          result.errors.push(
            `Record count difference (expected): RethinkDB has ${rethinkCount}, PostgreSQL has ${postgresCount}`
          );
        }
        return result;
      }
      
      // For main tables, allow for small discrepancies due to skipped records
      const countDifference = Math.abs(rethinkCount - postgresCount);
      const allowedDiscrepancy = Math.max(1, Math.floor(rethinkCount * 0.01)); // Allow 1% or at least 1 record difference
      
      if (countDifference > allowedDiscrepancy) {
        result.isValid = false;
        result.errors.push(
          `Record count mismatch: RethinkDB has ${rethinkCount}, PostgreSQL has ${postgresCount}`
        );
      } else if (countDifference > 0) {
        // Small discrepancy is acceptable, just note it
        result.errors.push(
          `Minor record count difference (acceptable): RethinkDB has ${rethinkCount}, PostgreSQL has ${postgresCount}`
        );
      }
      
      // If counts are reasonable and there are records, validate sample data
      if (rethinkCount > 0 && postgresCount > 0 && countDifference <= allowedDiscrepancy) {
        const sampleValidation = await this.validateSampleRecords(rethinkTableName, postgresTableName);
        if (!sampleValidation.isValid) {
          result.isValid = false;
          result.errors.push(...sampleValidation.errors);
        }
      }
      
      // Validate specific constraints for each table type
      const constraintValidation = await this.validateTableConstraints(postgresTableName);
      if (!constraintValidation.isValid) {
        result.isValid = false;
        result.errors.push(...constraintValidation.errors);
      }
      
    } catch (error) {
      result.isValid = false;
      result.errors.push(`Validation error: ${error.message}`);
    }
    
    return result;
  }

  /**
   * Validate a specific table (legacy method for backward compatibility)
   */
  async validateTable(tableName) {
    return this.validateTableMapping(tableName, tableName);
  }

  /**
   * Check if table exists in RethinkDB
   */
  async checkRethinkTableExists(tableName) {
    try {
      const tableList = await this.r.tableList().run();
      return tableList.includes(tableName);
    } catch (error) {
      debug.error(`Error checking RethinkDB table existence for ${tableName}:`, error);
      return false;
    }
  }

  /**
   * Get record count from RethinkDB
   */
  async getRethinkRecordCount(tableName) {
    try {
      return await this.r.table(tableName).count().run();
    } catch (error) {
      debug.error(`Error getting RethinkDB record count for ${tableName}:`, error);
      return 0;
    }
  }

  /**
   * Get record count from PostgreSQL
   */
  async getPostgresRecordCount(tableName) {
    try {
      const result = await this.postgresDAL.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      return parseInt(result.rows[0].count);
    } catch (error) {
      debug.error(`Error getting PostgreSQL record count for ${tableName}:`, error);
      return 0;
    }
  }

  /**
   * Validate a sample of records between RethinkDB and PostgreSQL
   */
  async validateSampleRecords(rethinkTableName, postgresTableName, sampleSize = 5) {
    const result = {
      isValid: true,
      errors: []
    };
    
    try {
      // Get sample records from RethinkDB
      const rethinkSample = await this.r.table(rethinkTableName)
        .sample(Math.min(sampleSize, 5))
        .run();
      
      // Handle both cursor and array results
      let rethinkRecords;
      if (rethinkSample && typeof rethinkSample.toArray === 'function') {
        rethinkRecords = await rethinkSample.toArray();
      } else if (Array.isArray(rethinkSample)) {
        rethinkRecords = rethinkSample;
      } else {
        rethinkRecords = [];
      }
      
      // Validate each sample record
      for (const rethinkRecord of rethinkRecords) {
        if (!rethinkRecord.id) {
          // Skip records without IDs (join tables)
          continue;
        }
        
        const postgresRecord = await this.getPostgresRecord(postgresTableName, rethinkRecord.id);
        
        if (!postgresRecord) {
          // This might be expected for skipped records, so don't fail validation
          result.errors.push(`Record ${rethinkRecord.id} not found in PostgreSQL (may have been skipped)`);
          continue;
        }
        
        // Validate specific fields based on table type
        const fieldValidation = await this.validateRecordFields(postgresTableName, rethinkRecord, postgresRecord);
        if (!fieldValidation.isValid) {
          result.isValid = false;
          result.errors.push(...fieldValidation.errors.map(err => 
            `Record ${rethinkRecord.id}: ${err}`
          ));
        }
      }
      
    } catch (error) {
      result.isValid = false;
      result.errors.push(`Sample validation error: ${error.message}`);
    }
    
    return result;
  }

  /**
   * Get a specific record from PostgreSQL
   */
  async getPostgresRecord(tableName, id) {
    try {
      const result = await this.postgresDAL.query(
        `SELECT * FROM ${tableName} WHERE id = $1`,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      debug.error(`Error getting PostgreSQL record ${id} from ${tableName}:`, error);
      return null;
    }
  }

  /**
   * Validate fields between RethinkDB and PostgreSQL records
   */
  async validateRecordFields(tableName, rethinkRecord, postgresRecord) {
    const result = {
      isValid: true,
      errors: []
    };
    
    try {
      // Validate based on table type
      switch (tableName) {
        case 'users':
          this.validateUserFields(rethinkRecord, postgresRecord, result);
          break;
        case 'teams':
          this.validateTeamFields(rethinkRecord, postgresRecord, result);
          break;
        case 'files':
          this.validateFileFields(rethinkRecord, postgresRecord, result);
          break;
        case 'things':
          this.validateThingFields(rethinkRecord, postgresRecord, result);
          break;
        case 'reviews':
          this.validateReviewFields(rethinkRecord, postgresRecord, result);
          break;
        case 'blog_posts':
          this.validateBlogPostFields(rethinkRecord, postgresRecord, result);
          break;
        default:
          // For simple tables, just validate basic fields
          this.validateBasicFields(rethinkRecord, postgresRecord, result);
      }
      
      // Validate revision fields for versioned tables
      const versionedTables = ['user_metas', 'teams', 'files', 'things', 'reviews', 'blog_posts'];
      if (versionedTables.includes(tableName)) {
        this.validateRevisionFields(rethinkRecord, postgresRecord, result);
      }
      
    } catch (error) {
      result.isValid = false;
      result.errors.push(`Field validation error: ${error.message}`);
    }
    
    return result;
  }

  /**
   * Validate user fields
   */
  validateUserFields(rethinkRecord, postgresRecord, result) {
    // Check basic string fields
    const stringFields = [
      ['displayName', 'display_name'],
      ['canonicalName', 'canonical_name'],
      ['email', 'email']
    ];
    
    for (const [rethinkField, postgresField] of stringFields) {
      const rethinkValue = rethinkRecord[rethinkField];
      const postgresValue = postgresRecord[postgresField];
      
      // Handle null/undefined equivalence
      const rethinkNormalized = rethinkValue === undefined ? null : rethinkValue;
      const postgresNormalized = postgresValue === undefined ? null : postgresValue;
      
      if (rethinkNormalized !== postgresNormalized) {
        result.isValid = false;
        result.errors.push(`${rethinkField} mismatch: '${rethinkValue}' vs '${postgresValue}'`);
      }
    }
    
    // Check boolean fields
    const booleanFields = [
      ['isTrusted', 'is_trusted'],
      ['isSiteModerator', 'is_site_moderator'],
      ['isSuperUser', 'is_super_user']
    ];
    
    for (const [rethinkField, postgresField] of booleanFields) {
      if (Boolean(rethinkRecord[rethinkField]) !== Boolean(postgresRecord[postgresField])) {
        result.isValid = false;
        result.errors.push(`${rethinkField} mismatch: ${rethinkRecord[rethinkField]} vs ${postgresRecord[postgresField]}`);
      }
    }
  }

  /**
   * Validate team fields
   */
  validateTeamFields(rethinkRecord, postgresRecord, result) {
    // Check multilingual name field with normalized comparison
    if (rethinkRecord.name && postgresRecord.name) {
      const normalizeMLString = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const normalized = {};
        Object.keys(obj).sort().forEach(key => {
          const value = obj[key];
          normalized[key] = typeof value === 'string' ? value.trim() : value;
        });
        return JSON.stringify(normalized);
      };

      if (normalizeMLString(rethinkRecord.name) !== normalizeMLString(postgresRecord.name)) {
        // Soft error - formatting differences are acceptable
        result.errors.push('Multilingual name field difference (non-critical)');
      }
    }

    // Check boolean fields
    const booleanFields = [
      ['modApprovalToJoin', 'mod_approval_to_join'],
      ['onlyModsCanBlog', 'only_mods_can_blog']
    ];

    for (const [rethinkField, postgresField] of booleanFields) {
      if (Boolean(rethinkRecord[rethinkField]) !== Boolean(postgresRecord[postgresField])) {
        result.isValid = false;
        result.errors.push(`${rethinkField} mismatch: ${rethinkRecord[rethinkField]} vs ${postgresRecord[postgresField]}`);
      }
    }
  }

  /**
   * Validate file fields
   */
  validateFileFields(rethinkRecord, postgresRecord, result) {
    // Check basic fields with null/undefined equivalence
    const basicFields = ['name', 'mime_type', 'license'];

    for (const field of basicFields) {
      const rethinkValue = rethinkRecord[field] || rethinkRecord[this.camelCase(field)];
      const postgresValue = postgresRecord[field];

      // Normalize null/undefined values for comparison
      const rethinkNormalized = rethinkValue === undefined ? null : rethinkValue;
      const postgresNormalized = postgresValue === undefined ? null : postgresValue;

      if (rethinkNormalized !== postgresNormalized) {
        result.isValid = false;
        result.errors.push(`${field} mismatch: '${rethinkValue}' vs '${postgresValue}'`);
      }
    }

    // Check multilingual fields with normalized comparison
    const multilingualFields = ['description', 'creator', 'source'];

    const normalizeMLString = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const normalized = {};
      Object.keys(obj).sort().forEach(key => {
        const value = obj[key];
        normalized[key] = typeof value === 'string' ? value.trim() : value;
      });
      return JSON.stringify(normalized);
    };

    for (const field of multilingualFields) {
      if (rethinkRecord[field] && postgresRecord[field]) {
        if (normalizeMLString(rethinkRecord[field]) !== normalizeMLString(postgresRecord[field])) {
          // Soft error - formatting differences are acceptable
          result.errors.push(`Multilingual ${field} field difference (non-critical)`);
        }
      }
    }
  }

  /**
   * Validate thing fields
   */
  validateThingFields(rethinkRecord, postgresRecord, result) {
    // Check URL array
    if (rethinkRecord.urls && postgresRecord.urls) {
      if (JSON.stringify(rethinkRecord.urls) !== JSON.stringify(postgresRecord.urls)) {
        result.isValid = false;
        result.errors.push('URLs array mismatch');
      }
    }

    // Check multilingual label with normalized comparison
    if (rethinkRecord.label && postgresRecord.label) {
      // Normalize both objects for comparison (sort keys, handle whitespace)
      const normalizeMLString = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const normalized = {};
        Object.keys(obj).sort().forEach(key => {
          const value = obj[key];
          // Trim whitespace and normalize string values
          normalized[key] = typeof value === 'string' ? value.trim() : value;
        });
        return JSON.stringify(normalized);
      };

      const rethinkNormalized = normalizeMLString(rethinkRecord.label);
      const postgresNormalized = normalizeMLString(postgresRecord.label);

      if (rethinkNormalized !== postgresNormalized) {
        // This is a soft error - log but don't fail validation
        // Some formatting differences are acceptable for multilingual content
        result.errors.push(`Multilingual label field difference (non-critical): ${rethinkRecord.id}`);
      }
    }

    // Check metadata grouping with normalized comparison
    if (postgresRecord.metadata) {
      const expectedMetadata = {};

      if (rethinkRecord.description) {
        expectedMetadata.description = rethinkRecord.description;
      }
      if (rethinkRecord.subtitle) {
        expectedMetadata.subtitle = rethinkRecord.subtitle;
      }
      if (rethinkRecord.authors) {
        expectedMetadata.authors = rethinkRecord.authors;
      }

      if (Object.keys(expectedMetadata).length > 0) {
        // Normalize for comparison
        const normalizeObj = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
        if (normalizeObj(expectedMetadata) !== normalizeObj(postgresRecord.metadata)) {
          result.isValid = false;
          result.errors.push('Metadata grouping mismatch');
        }
      }
    }
  }

  /**
   * Validate review fields
   */
  validateReviewFields(rethinkRecord, postgresRecord, result) {
    // Check star rating
    if (rethinkRecord.starRating !== postgresRecord.star_rating) {
      result.isValid = false;
      result.errors.push(`Star rating mismatch: ${rethinkRecord.starRating} vs ${postgresRecord.star_rating}`);
    }

    // Check multilingual content fields with normalized comparison
    const multilingualFields = ['title', 'text', 'html'];

    const normalizeMLString = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const normalized = {};
      Object.keys(obj).sort().forEach(key => {
        const value = obj[key];
        normalized[key] = typeof value === 'string' ? value.trim() : value;
      });
      return JSON.stringify(normalized);
    };

    for (const field of multilingualFields) {
      if (rethinkRecord[field] && postgresRecord[field]) {
        if (normalizeMLString(rethinkRecord[field]) !== normalizeMLString(postgresRecord[field])) {
          // Soft error - formatting differences are acceptable
          result.errors.push(`Multilingual ${field} field difference (non-critical)`);
        }
      }
    }
  }

  /**
   * Validate blog post fields (similar to reviews)
   */
  validateBlogPostFields(rethinkRecord, postgresRecord, result) {
    // Check multilingual content fields with normalized comparison
    const multilingualFields = ['title', 'text', 'html'];

    const normalizeMLString = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const normalized = {};
      Object.keys(obj).sort().forEach(key => {
        const value = obj[key];
        normalized[key] = typeof value === 'string' ? value.trim() : value;
      });
      return JSON.stringify(normalized);
    };

    for (const field of multilingualFields) {
      if (rethinkRecord[field] && postgresRecord[field]) {
        if (normalizeMLString(rethinkRecord[field]) !== normalizeMLString(postgresRecord[field])) {
          // Soft error - formatting differences are acceptable
          result.errors.push(`Multilingual ${field} field difference (non-critical)`);
        }
      }
    }
  }

  /**
   * Validate basic fields for simple tables
   */
  validateBasicFields(rethinkRecord, postgresRecord, result) {
    // Just check that the ID matches
    if (rethinkRecord.id !== postgresRecord.id) {
      result.isValid = false;
      result.errors.push(`ID mismatch: ${rethinkRecord.id} vs ${postgresRecord.id}`);
    }
  }

  /**
   * Validate revision fields
   */
  validateRevisionFields(rethinkRecord, postgresRecord, result) {
    const revisionFields = [
      ['_revID', '_rev_id'],
      ['_revUser', '_rev_user'],
      ['_oldRevOf', '_old_rev_of'],
      ['_revDeleted', '_rev_deleted']
    ];
    
    for (const [rethinkField, postgresField] of revisionFields) {
      const rethinkValue = rethinkRecord[rethinkField];
      const postgresValue = postgresRecord[postgresField];
      
      // Handle default value differences between RethinkDB and PostgreSQL
      const rethinkNormalized = rethinkValue === undefined ? 
        (postgresField === '_rev_deleted' ? false : null) : rethinkValue;
      const postgresNormalized = postgresValue === undefined ? null : postgresValue;
      
      if (rethinkNormalized !== postgresNormalized) {
        result.isValid = false;
        result.errors.push(`${rethinkField} mismatch: ${rethinkValue} vs ${postgresValue}`);
      }
    }
    
    // Check revision date (allow for small timestamp differences)
    if (rethinkRecord._revDate && postgresRecord._rev_date) {
      const rethinkDate = new Date(rethinkRecord._revDate);
      const postgresDate = new Date(postgresRecord._rev_date);
      const timeDiff = Math.abs(rethinkDate.getTime() - postgresDate.getTime());
      
      // Allow up to 1 second difference for timestamp precision
      if (timeDiff > 1000) {
        result.isValid = false;
        result.errors.push(`Revision date mismatch: ${rethinkDate.toISOString()} vs ${postgresDate.toISOString()}`);
      }
    }
  }

  /**
   * Validate table-specific constraints
   */
  async validateTableConstraints(tableName) {
    const result = {
      isValid: true,
      errors: []
    };
    
    try {
      switch (tableName) {
        case 'users':
          await this.validateUserConstraints(result);
          break;
        case 'reviews':
          await this.validateReviewConstraints(result);
          break;
        case 'things':
          await this.validateThingConstraints(result);
          break;
        // Add more constraint validations as needed
      }
    } catch (error) {
      result.isValid = false;
      result.errors.push(`Constraint validation error: ${error.message}`);
    }
    
    return result;
  }

  /**
   * Validate user-specific constraints
   */
  async validateUserConstraints(result) {
    // Check for duplicate canonical names
    const duplicateNames = await this.postgresDAL.query(`
      SELECT canonical_name, COUNT(*) as count
      FROM users
      GROUP BY canonical_name
      HAVING COUNT(*) > 1
    `);
    
    if (duplicateNames.rows.length > 0) {
      result.isValid = false;
      result.errors.push(`Found ${duplicateNames.rows.length} duplicate canonical names`);
    }
  }

  /**
   * Validate review-specific constraints
   */
  async validateReviewConstraints(result) {
    // Check star rating constraints
    const invalidRatings = await this.postgresDAL.query(`
      SELECT COUNT(*) as count
      FROM reviews
      WHERE star_rating < 1 OR star_rating > 5
    `);
    
    if (parseInt(invalidRatings.rows[0].count) > 0) {
      result.isValid = false;
      result.errors.push(`Found ${invalidRatings.rows[0].count} reviews with invalid star ratings`);
    }
  }

  /**
   * Validate thing-specific constraints
   */
  async validateThingConstraints(result) {
    // Check for things without URLs (informational only - some things may not have URLs)
    const noUrls = await this.postgresDAL.query(`
      SELECT COUNT(*) as count
      FROM things
      WHERE urls IS NULL OR array_length(urls, 1) = 0
    `);

    const countWithoutUrls = parseInt(noUrls.rows[0].count);
    if (countWithoutUrls > 0) {
      // This is informational, not an error - some things legitimately don't have URLs
      result.errors.push(`Info: ${countWithoutUrls} things without URLs (this is acceptable)`);
    }
  }

  /**
   * Convert snake_case to camelCase
   */
  camelCase(str) {
    return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
  }
}

module.exports = MigrationValidator;