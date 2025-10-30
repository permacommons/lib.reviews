#!/usr/bin/env node
'use strict';

/**
 * Migration Validation Script
 * 
 * Validates the migration setup and data integrity without performing
 * the actual migration. Useful for testing and pre-migration checks.
 * 
 * Usage:
 *   node migrations/validate-migration.js [options]
 * 
 * Options:
 *   --check-connections    Test database connections
 *   --check-schema         Validate PostgreSQL schema
 *   --check-data           Compare sample data between databases
 *   --verbose              Show detailed output
 */

const config = require('config');
const debug = require('../util/debug');

// Database connections
const rethinkThinky = require('../db');
const PostgresDAL = require('../dal');

// Migration utilities
const MigrationValidator = require('./lib/migration-validator');
const MigrationReporter = require('./lib/migration-reporter');

class MigrationValidation {
  constructor(options = {}) {
    this.options = {
      checkConnections: options.checkConnections || false,
      checkSchema: options.checkSchema || false,
      checkData: options.checkData || false,
      verbose: options.verbose || false,
      ...options
    };
    
    this.rethinkDB = null;
    this.postgresDAL = null;
    this.validator = null;
    this.reporter = null;
    
    this.results = {
      connections: { rethink: false, postgres: false },
      schema: { valid: false, errors: [] },
      data: { valid: false, errors: [] },
      overall: false
    };
  }

  /**
   * Run all validation checks
   */
  async validate() {
    this.log('Starting migration validation...');
    
    try {
      if (this.options.checkConnections) {
        await this.validateConnections();
      }
      
      if (this.options.checkSchema) {
        await this.validateSchema();
      }
      
      if (this.options.checkData) {
        await this.validateData();
      }
      
      // Determine overall result
      this.results.overall = this.determineOverallResult();
      
      await this.generateValidationReport();
      
      return this.results;
      
    } catch (error) {
      this.error('Validation failed:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Validate database connections
   */
  async validateConnections() {
    this.log('Validating database connections...');
    
    // Test RethinkDB connection
    try {
      this.rethinkDB = await rethinkThinky.getDB();
      
      // Test basic query
      const tableList = await this.rethinkDB.r.tableList().run();
      this.results.connections.rethink = true;
      this.log(`✓ RethinkDB connection successful (${tableList.length} tables found)`);
      
    } catch (error) {
      this.results.connections.rethink = false;
      this.error('RethinkDB connection failed:', error);
    }
    
    // Test PostgreSQL connection
    try {
      this.postgresDAL = PostgresDAL({
        host: config.postgres?.host || 'localhost',
        port: config.postgres?.port || 5432,
        database: config.postgres?.database || 'libreviews',
        user: config.postgres?.user || 'postgres',
        password: config.postgres?.password || '',
        max: 5
      });
      
      await this.postgresDAL.connect();
      
      // Test basic query
      const result = await this.postgresDAL.query('SELECT NOW() as current_time');
      this.results.connections.postgres = true;
      this.log(`✓ PostgreSQL connection successful (${result.rows[0].current_time})`);
      
    } catch (error) {
      this.results.connections.postgres = false;
      this.error('PostgreSQL connection failed:', error);
    }
  }

  /**
   * Validate PostgreSQL schema
   */
  async validateSchema() {
    this.log('Validating PostgreSQL schema...');
    
    if (!this.postgresDAL) {
      await this.initializePostgres();
    }
    
    try {
      // Check if all required tables exist
      const requiredTables = [
        'users', 'user_metas', 'teams', 'files', 'things', 'reviews',
        'blog_posts', 'invite_links', 'team_join_requests', 'team_slugs',
        'thing_slugs', 'team_members', 'team_moderators', 'review_teams',
        'thing_files'
      ];
      
      const existingTables = await this.getPostgresTables();
      const missingTables = requiredTables.filter(table => !existingTables.includes(table));
      
      if (missingTables.length > 0) {
        this.results.schema.valid = false;
        this.results.schema.errors.push(`Missing tables: ${missingTables.join(', ')}`);
      } else {
        this.log(`✓ All ${requiredTables.length} required tables exist`);
      }
      
      // Check indexes
      const indexValidation = await this.validateIndexes();
      if (!indexValidation.valid) {
        this.results.schema.valid = false;
        this.results.schema.errors.push(...indexValidation.errors);
      } else {
        this.log('✓ Critical indexes exist');
      }
      
      // Check constraints
      const constraintValidation = await this.validateConstraints();
      if (!constraintValidation.valid) {
        this.results.schema.valid = false;
        this.results.schema.errors.push(...constraintValidation.errors);
      } else {
        this.log('✓ Foreign key constraints exist');
      }
      
      if (this.results.schema.errors.length === 0) {
        this.results.schema.valid = true;
        this.log('✓ PostgreSQL schema validation passed');
      }
      
    } catch (error) {
      this.results.schema.valid = false;
      this.results.schema.errors.push(`Schema validation error: ${error.message}`);
      this.error('Schema validation failed:', error);
    }
  }

  /**
   * Validate data integrity (if both databases have data)
   */
  async validateData() {
    this.log('Validating data integrity...');
    
    if (!this.rethinkDB || !this.postgresDAL) {
      await this.initializeConnections();
    }
    
    try {
      this.validator = new MigrationValidator(this.rethinkDB, this.postgresDAL);
      
      // Check a few key tables for data consistency
      const tablesToCheck = ['users', 'things', 'reviews'];
      
      for (const tableName of tablesToCheck) {
        const validation = await this.validator.validateTable(tableName);
        
        if (!validation.isValid) {
          this.results.data.valid = false;
          this.results.data.errors.push(`${tableName}: ${validation.errors.join(', ')}`);
        } else if (validation.recordCount > 0) {
          this.log(`✓ ${tableName}: ${validation.recordCount} records validated`);
        }
      }
      
      if (this.results.data.errors.length === 0) {
        this.results.data.valid = true;
        this.log('✓ Data integrity validation passed');
      }
      
    } catch (error) {
      this.results.data.valid = false;
      this.results.data.errors.push(`Data validation error: ${error.message}`);
      this.error('Data validation failed:', error);
    }
  }

  /**
   * Get list of PostgreSQL tables
   */
  async getPostgresTables() {
    const result = await this.postgresDAL.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    `);
    
    return result.rows.map(row => row.table_name);
  }

  /**
   * Validate critical indexes exist
   */
  async validateIndexes() {
    const result = { valid: true, errors: [] };
    
    // Check for critical revision system indexes
    const criticalIndexes = [
      'idx_things_current',
      'idx_reviews_current',
      'idx_teams_current',
      'idx_files_current'
    ];
    
    for (const indexName of criticalIndexes) {
      const indexExists = await this.checkIndexExists(indexName);
      if (!indexExists) {
        result.valid = false;
        result.errors.push(`Missing critical index: ${indexName}`);
      }
    }
    
    return result;
  }

  /**
   * Check if an index exists
   */
  async checkIndexExists(indexName) {
    try {
      const result = await this.postgresDAL.query(`
        SELECT 1
        FROM pg_indexes
        WHERE indexname = $1
      `, [indexName]);
      
      return result.rows.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate foreign key constraints
   */
  async validateConstraints() {
    const result = { valid: true, errors: [] };
    
    // Check for critical foreign key constraints
    const criticalConstraints = [
      'reviews_thing_id_fkey',
      'reviews_created_by_fkey',
      'things_created_by_fkey',
      'teams_created_by_fkey'
    ];
    
    for (const constraintName of criticalConstraints) {
      const constraintExists = await this.checkConstraintExists(constraintName);
      if (!constraintExists) {
        result.valid = false;
        result.errors.push(`Missing foreign key constraint: ${constraintName}`);
      }
    }
    
    return result;
  }

  /**
   * Check if a constraint exists
   */
  async checkConstraintExists(constraintName) {
    try {
      const result = await this.postgresDAL.query(`
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = $1
        AND constraint_type = 'FOREIGN KEY'
      `, [constraintName]);
      
      return result.rows.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Initialize database connections
   */
  async initializeConnections() {
    if (!this.rethinkDB) {
      try {
        this.rethinkDB = await rethinkThinky.getDB();
      } catch (error) {
        this.error('Failed to initialize RethinkDB:', error);
      }
    }
    
    if (!this.postgresDAL) {
      await this.initializePostgres();
    }
  }

  /**
   * Initialize PostgreSQL connection
   */
  async initializePostgres() {
    try {
      this.postgresDAL = PostgresDAL({
        host: config.postgres?.host || 'localhost',
        port: config.postgres?.port || 5432,
        database: config.postgres?.database || 'libreviews',
        user: config.postgres?.user || 'postgres',
        password: config.postgres?.password || '',
        max: 5
      });
      
      await this.postgresDAL.connect();
    } catch (error) {
      this.error('Failed to initialize PostgreSQL:', error);
    }
  }

  /**
   * Determine overall validation result
   */
  determineOverallResult() {
    // If checking connections, both must be successful
    if (this.options.checkConnections) {
      if (!this.results.connections.rethink || !this.results.connections.postgres) {
        return false;
      }
    }
    
    // If checking schema, it must be valid
    if (this.options.checkSchema) {
      if (!this.results.schema.valid) {
        return false;
      }
    }
    
    // If checking data, it must be valid
    if (this.options.checkData) {
      if (!this.results.data.valid) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Generate validation report
   */
  async generateValidationReport() {
    this.reporter = new MigrationReporter(this.options);
    
    const report = {
      validation: {
        timestamp: new Date().toISOString(),
        options: this.options,
        results: this.results
      },
      
      summary: {
        overall: this.results.overall ? 'PASS' : 'FAIL',
        connectionsChecked: this.options.checkConnections,
        schemaChecked: this.options.checkSchema,
        dataChecked: this.options.checkData
      },
      
      details: {
        connections: this.results.connections,
        schema: this.results.schema,
        data: this.results.data
      },
      
      recommendations: this.generateRecommendations()
    };
    
    // Print summary
    this.log('\n--- Validation Summary ---');
    this.log(`Overall result: ${report.summary.overall}`);
    
    if (this.options.checkConnections) {
      this.log(`RethinkDB connection: ${this.results.connections.rethink ? 'OK' : 'FAILED'}`);
      this.log(`PostgreSQL connection: ${this.results.connections.postgres ? 'OK' : 'FAILED'}`);
    }
    
    if (this.options.checkSchema) {
      this.log(`Schema validation: ${this.results.schema.valid ? 'OK' : 'FAILED'}`);
      if (this.results.schema.errors.length > 0) {
        this.results.schema.errors.forEach(error => this.log(`  - ${error}`));
      }
    }
    
    if (this.options.checkData) {
      this.log(`Data validation: ${this.results.data.valid ? 'OK' : 'FAILED'}`);
      if (this.results.data.errors.length > 0) {
        this.results.data.errors.forEach(error => this.log(`  - ${error}`));
      }
    }
    
    return report;
  }

  /**
   * Generate recommendations based on validation results
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (!this.results.connections.rethink) {
      recommendations.push({
        type: 'connection',
        message: 'Fix RethinkDB connection before attempting migration',
        priority: 'high'
      });
    }
    
    if (!this.results.connections.postgres) {
      recommendations.push({
        type: 'connection',
        message: 'Fix PostgreSQL connection and run schema migrations',
        priority: 'high'
      });
    }
    
    if (!this.results.schema.valid) {
      recommendations.push({
        type: 'schema',
        message: 'Run PostgreSQL schema migrations to create required tables and indexes',
        priority: 'high'
      });
    }
    
    if (!this.results.data.valid && this.results.data.errors.length > 0) {
      recommendations.push({
        type: 'data',
        message: 'Review data integrity issues before migration',
        priority: 'medium'
      });
    }
    
    if (this.results.overall) {
      recommendations.push({
        type: 'success',
        message: 'Validation passed - migration can proceed',
        priority: 'low'
      });
    }
    
    return recommendations;
  }

  /**
   * Clean up database connections
   */
  async cleanup() {
    try {
      if (this.postgresDAL) {
        await this.postgresDAL.disconnect();
      }
      // RethinkDB cleanup is handled by Thinky
    } catch (error) {
      this.error('Error during cleanup:', error);
    }
  }

  /**
   * Log message with timestamp
   */
  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    
    if (this.options.verbose) {
      debug.db(message);
    }
  }

  /**
   * Log error message
   */
  error(message, error = null) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`);
    
    if (error && this.options.verbose) {
      console.error(error);
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    checkConnections: true,
    checkSchema: true,
    checkData: false // Default to false since it requires existing data
  };
  
  // Parse command line arguments
  for (const arg of args) {
    if (arg === '--check-connections') {
      options.checkConnections = true;
    } else if (arg === '--check-schema') {
      options.checkSchema = true;
    } else if (arg === '--check-data') {
      options.checkData = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    }
  }
  
  // Run validation
  const validation = new MigrationValidation(options);
  
  validation.validate()
    .then((results) => {
      if (results.overall) {
        console.log('\n✓ Validation completed successfully');
        process.exit(0);
      } else {
        console.log('\n✗ Validation failed');
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('\n✗ Validation error:', error.message);
      process.exit(1);
    });
}

module.exports = MigrationValidation;