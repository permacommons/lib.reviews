#!/usr/bin/env node
'use strict';

/**
 * RethinkDB to PostgreSQL Migration Pipeline
 * 
 * This script performs a complete migration from RethinkDB to PostgreSQL,
 * handling data transformation, validation, and integrity checking.
 * 
 * Usage:
 *   node migrations/migrate-rethinkdb-to-postgres.js [options]
 * 
 * Options:
 *   --dry-run          Show what would be migrated without making changes
 *   --batch-size=N     Number of records to process in each batch (default: 1000)
 *   --validate-only    Only validate data integrity, don't migrate
 *   --table=NAME       Migrate only specific table (users, things, reviews, etc.)
 *   --verbose          Show detailed progress information
 */

const fs = require('fs').promises;
const path = require('path');
const { performance } = require('perf_hooks');

// Database connections
const config = require('config');
const debug = require('../util/debug');

// RethinkDB connection
const rethinkThinky = require('../db');
const r = rethinkThinky.r;

// PostgreSQL DAL
const PostgresDAL = require('../dal');

// Migration utilities
const MigrationValidator = require('./lib/migration-validator');
const DataTransformer = require('./lib/data-transformer');
const MigrationReporter = require('./lib/migration-reporter');

class RethinkDBToPostgresMigration {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      batchSize: options.batchSize || 1000,
      validateOnly: options.validateOnly || false,
      table: options.table || null,
      verbose: options.verbose || false,
      ...options
    };
    
    this.rethinkDB = null;
    this.postgresDAL = null;
    this.validator = null;
    this.transformer = null;
    this.reporter = null;
    
    this.stats = {
      startTime: null,
      endTime: null,
      tablesProcessed: 0,
      recordsMigrated: 0,
      recordsSkipped: 0,
      errors: []
    };
  }

  /**
   * Initialize database connections and migration utilities
   */
  async initialize() {
    this.log('Initializing migration pipeline...');
    
    try {
      // Initialize RethinkDB connection
      this.rethinkDB = await rethinkThinky.getDB();
      this.log('✓ RethinkDB connection established');
      
      // Initialize PostgreSQL DAL
      this.postgresDAL = PostgresDAL({
        host: config.postgres?.host || 'localhost',
        port: config.postgres?.port || 5432,
        database: config.postgres?.database || 'libreviews',
        user: config.postgres?.user || 'postgres',
        password: config.postgres?.password || '',
        max: 20
      });
      
      await this.postgresDAL.connect();
      this.log('✓ PostgreSQL connection established');
      
      // Run PostgreSQL migrations to ensure schema is up to date
      if (!this.options.dryRun) {
        try {
          await this.postgresDAL.migrate();
          this.log('✓ PostgreSQL schema migrations completed');
        } catch (error) {
          if (error.message.includes('already exists')) {
            this.log('✓ PostgreSQL schema already exists, skipping migrations');
          } else {
            throw error;
          }
        }
      }
      
      // Initialize utilities
      this.validator = new MigrationValidator(this.rethinkDB, this.postgresDAL);
      this.transformer = new DataTransformer();
      this.reporter = new MigrationReporter(this.options);
      
      this.log('✓ Migration pipeline initialized');
      
    } catch (error) {
      this.error('Failed to initialize migration pipeline:', error);
      throw error;
    }
  }

  /**
   * Execute the complete migration process
   */
  async migrate() {
    this.stats.startTime = performance.now();
    
    try {
      await this.initialize();
      
      if (this.options.validateOnly) {
        await this.validateDataIntegrity();
        return;
      }
      
      // Define migration order with RethinkDB -> PostgreSQL table mappings
      const migrationOrder = [
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
        // Join tables last
        { rethink: 'teams_users_membership', postgres: 'team_members' },
        { rethink: 'teams_users_moderatorship', postgres: 'team_moderators' },
        { rethink: 'reviews_teams_team_content', postgres: 'review_teams' },
        { rethink: 'files_things_media_usage', postgres: 'thing_files' }
      ];
      
      // Filter to specific table if requested
      const tablesToMigrate = this.options.table 
        ? migrationOrder.filter(mapping => 
            mapping.postgres === this.options.table || mapping.rethink === this.options.table
          )
        : migrationOrder;
      
      this.log(`Starting migration of ${tablesToMigrate.length} tables...`);
      
      // Migrate each table
      for (const tableMapping of tablesToMigrate) {
        await this.migrateTable(tableMapping.rethink, tableMapping.postgres);
        this.stats.tablesProcessed++;
      }
      
      // Validate data integrity after migration (only for migrated tables)
      if (!this.options.dryRun) {
        this.log('Validating migrated data integrity...');
        const postgresTableNames = tablesToMigrate.map(mapping => mapping.postgres);
        await this.validateDataIntegrity(postgresTableNames);
      }
      
      this.stats.endTime = performance.now();
      await this.generateReport();
      
    } catch (error) {
      this.stats.errors.push({
        type: 'migration_error',
        message: error.message,
        stack: error.stack,
        timestamp: new Date()
      });
      
      this.error('Migration failed:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Migrate a single table from RethinkDB to PostgreSQL
   */
  async migrateTable(rethinkTableName, postgresTableName) {
    this.log(`\n--- Migrating table: ${rethinkTableName} -> ${postgresTableName} ---`);
    
    try {
      // Check if table exists in RethinkDB
      const tableExists = await this.checkRethinkTableExists(rethinkTableName);
      if (!tableExists) {
        this.log(`⚠ Table ${rethinkTableName} does not exist in RethinkDB, skipping`);
        return;
      }
      
      // Get total record count for progress tracking
      const totalRecords = await this.getRethinkTableCount(rethinkTableName);
      this.log(`Found ${totalRecords} records in RethinkDB table ${rethinkTableName}`);
      
      if (totalRecords === 0) {
        this.log(`✓ Table ${rethinkTableName} is empty, skipping`);
        return;
      }
      
      // Clear existing data in PostgreSQL if not dry run
      if (!this.options.dryRun) {
        await this.clearPostgresTable(postgresTableName);
      }
      
      // Migrate data in batches
      let processedRecords = 0;
      let batchNumber = 1;
      
      while (processedRecords < totalRecords) {
        const batchStart = performance.now();
        
        // Fetch batch from RethinkDB
        const batch = await this.fetchRethinkBatch(rethinkTableName, processedRecords, this.options.batchSize);
        
        if (batch.length === 0) {
          break;
        }
        
        // Transform data for PostgreSQL
        const transformedBatch = await this.transformer.transformBatch(postgresTableName, batch);
        
        // Validate and clean foreign key references
        const cleanedBatch = await this.validateForeignKeyReferences(postgresTableName, transformedBatch);
        
        // Insert into PostgreSQL
        if (!this.options.dryRun) {
          await this.insertPostgresBatch(postgresTableName, cleanedBatch);
        }
        
        processedRecords += batch.length;
        this.stats.recordsMigrated += batch.length;
        
        const batchTime = performance.now() - batchStart;
        const progress = ((processedRecords / totalRecords) * 100).toFixed(1);
        
        this.log(`  Batch ${batchNumber}: ${batch.length} records (${progress}%) - ${batchTime.toFixed(0)}ms`);
        
        batchNumber++;
      }
      
      this.log(`✓ Completed migration of ${rethinkTableName} -> ${postgresTableName}: ${processedRecords} records`);
      
    } catch (error) {
      this.stats.errors.push({
        type: 'table_migration_error',
        table: `${rethinkTableName} -> ${postgresTableName}`,
        message: error.message,
        stack: error.stack,
        timestamp: new Date()
      });
      
      this.error(`Failed to migrate table ${rethinkTableName} -> ${postgresTableName}:`, error);
      throw error;
    }
  }

  /**
   * Check if a table exists in RethinkDB
   */
  async checkRethinkTableExists(tableName) {
    try {
      const tableList = await r.tableList().run();
      return tableList.includes(tableName);
    } catch (error) {
      this.error(`Error checking RethinkDB table existence for ${tableName}:`, error);
      return false;
    }
  }

  /**
   * Get record count from RethinkDB table
   */
  async getRethinkTableCount(tableName) {
    try {
      const count = await r.table(tableName).count().run();
      return typeof count === 'number' ? count : 0;
    } catch (error) {
      this.error(`Error getting record count for ${tableName}:`, error);
      return 0;
    }
  }

  /**
   * Clear existing data from PostgreSQL table
   */
  async clearPostgresTable(tableName) {
    try {
      await this.postgresDAL.query(`TRUNCATE TABLE ${tableName} CASCADE`);
      this.log(`  Cleared existing data from PostgreSQL table ${tableName}`);
    } catch (error) {
      this.error(`Error clearing PostgreSQL table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Fetch a batch of records from RethinkDB
   */
  async fetchRethinkBatch(tableName, offset, limit) {
    try {
      const result = await r.table(tableName)
        .orderBy('id')
        .skip(offset)
        .limit(limit)
        .run();
      
      // Handle both cursor and array results
      if (result && typeof result.toArray === 'function') {
        return await result.toArray();
      } else if (Array.isArray(result)) {
        return result;
      } else {
        return [];
      }
    } catch (error) {
      this.error(`Error fetching batch from RethinkDB table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Validate and clean foreign key references in a batch
   */
  async validateForeignKeyReferences(tableName, batch) {
    const cleanedBatch = [];
    
    for (const record of batch) {
      const cleanedRecord = { ...record };
      
      // Handle table-specific foreign key validations
      switch (tableName) {
        case 'invite_links':
          // Check if created_by and used_by users exist
          if (cleanedRecord.created_by) {
            const creatorExists = await this.checkUserExists(cleanedRecord.created_by);
            if (!creatorExists) {
              this.log(`⚠ Skipping invite link ${cleanedRecord.id}: creator ${cleanedRecord.created_by} not found`);
              this.stats.recordsSkipped++;
              continue; // Skip this record
            }
          }
          
          if (cleanedRecord.used_by) {
            const userExists = await this.checkUserExists(cleanedRecord.used_by);
            if (!userExists) {
              this.log(`⚠ Cleaning invite link ${cleanedRecord.id}: used_by user ${cleanedRecord.used_by} not found, setting to NULL`);
              cleanedRecord.used_by = null;
            }
          }
          break;
          
        case 'things':
          // Check if created_by user exists
          if (cleanedRecord.created_by) {
            const creatorExists = await this.checkUserExists(cleanedRecord.created_by);
            if (!creatorExists) {
              this.log(`⚠ Skipping thing ${cleanedRecord.id}: creator ${cleanedRecord.created_by} not found`);
              this.stats.recordsSkipped++;
              continue; // Skip this record
            }
          }
          
          // Check if _rev_user exists (if different from created_by)
          if (cleanedRecord._rev_user && cleanedRecord._rev_user !== cleanedRecord.created_by) {
            const revUserExists = await this.checkUserExists(cleanedRecord._rev_user);
            if (!revUserExists) {
              this.log(`⚠ Cleaning thing ${cleanedRecord.id}: _rev_user ${cleanedRecord._rev_user} not found, setting to created_by`);
              cleanedRecord._rev_user = cleanedRecord.created_by;
            }
          }
          break;
          
        case 'reviews':
          // Check if created_by user exists
          if (cleanedRecord.created_by) {
            const creatorExists = await this.checkUserExists(cleanedRecord.created_by);
            if (!creatorExists) {
              this.log(`⚠ Skipping review ${cleanedRecord.id}: creator ${cleanedRecord.created_by} not found`);
              this.stats.recordsSkipped++;
              continue; // Skip this record
            }
          }
          
          // Check if thing_id exists (we'll need to implement checkThingExists)
          if (cleanedRecord.thing_id) {
            const thingExists = await this.checkThingExists(cleanedRecord.thing_id);
            if (!thingExists) {
              this.log(`⚠ Skipping review ${cleanedRecord.id}: thing ${cleanedRecord.thing_id} not found`);
              this.stats.recordsSkipped++;
              continue; // Skip this record
            }
          }
          break;
          
        // Add other table validations as needed
        default:
          // No special validation needed
          break;
      }
      
      cleanedBatch.push(cleanedRecord);
    }
    
    return cleanedBatch;
  }

  /**
   * Check if a user exists in PostgreSQL
   */
  async checkUserExists(userId) {
    try {
      const result = await this.postgresDAL.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      return result.rows.length > 0;
    } catch (error) {
      this.error(`Error checking user existence for ${userId}:`, error);
      return false;
    }
  }

  /**
   * Check if a thing exists in PostgreSQL
   */
  async checkThingExists(thingId) {
    try {
      const result = await this.postgresDAL.query('SELECT 1 FROM things WHERE id = $1', [thingId]);
      return result.rows.length > 0;
    } catch (error) {
      this.error(`Error checking thing existence for ${thingId}:`, error);
      return false;
    }
  }

  /**
   * Insert a batch of records into PostgreSQL
   */
  async insertPostgresBatch(tableName, batch) {
    if (batch.length === 0) {
      return;
    }
    
    try {
      await this.postgresDAL.transaction(async (client) => {
        for (const record of batch) {
          await this.insertPostgresRecord(client, tableName, record);
        }
      });
    } catch (error) {
      this.error(`Error inserting batch into PostgreSQL table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Insert a single record into PostgreSQL
   */
  async insertPostgresRecord(client, tableName, record) {
    try {
      const columns = Object.keys(record);
      const values = Object.values(record);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
      
      const query = `
        INSERT INTO ${tableName} (${columns.join(', ')})
        VALUES (${placeholders})
      `;
      
      await client.query(query, values);
    } catch (error) {
      this.error(`Error inserting record into ${tableName}:`, error);
      this.error('Record data:', record);
      throw error;
    }
  }

  /**
   * Validate data integrity between RethinkDB and PostgreSQL
   */
  async validateDataIntegrity(tablesToValidate = null) {
    this.log('\n--- Validating Data Integrity ---');
    
    try {
      let validationResults;
      
      if (tablesToValidate && tablesToValidate.length > 0) {
        // Only validate the tables that were migrated
        validationResults = {};
        for (const tableName of tablesToValidate) {
          validationResults[tableName] = await this.validator.validateTable(tableName);
        }
      } else {
        // Validate all tables
        validationResults = await this.validator.validateAllTables();
      }
      
      let hasErrors = false;
      for (const [tableName, result] of Object.entries(validationResults)) {
        if (result.isValid) {
          this.log(`✓ ${tableName}: ${result.recordCount} records validated`);
        } else {
          this.log(`✗ ${tableName}: Validation failed`);
          result.errors.forEach(error => this.log(`  - ${error}`));
          hasErrors = true;
        }
      }
      
      if (hasErrors) {
        throw new Error('Data integrity validation failed');
      }
      
      this.log('✓ All data integrity checks passed');
      
    } catch (error) {
      this.error('Data integrity validation failed:', error);
      throw error;
    }
  }

  /**
   * Generate migration report
   */
  async generateReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const report = await this.reporter.generateReport(this.stats, duration);
    
    // Write report to file
    const reportPath = path.join(__dirname, '..', 'migration-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    this.log(`\n--- Migration Report ---`);
    this.log(`Duration: ${(duration / 1000).toFixed(2)} seconds`);
    this.log(`Tables processed: ${this.stats.tablesProcessed}`);
    this.log(`Records migrated: ${this.stats.recordsMigrated}`);
    this.log(`Records skipped: ${this.stats.recordsSkipped}`);
    this.log(`Errors: ${this.stats.errors.length}`);
    this.log(`Report saved to: ${reportPath}`);
  }

  /**
   * Clean up database connections
   */
  async cleanup() {
    try {
      if (this.postgresDAL) {
        await this.postgresDAL.disconnect();
        this.log('✓ PostgreSQL connection closed');
      }
      
      // RethinkDB connection cleanup is handled by Thinky
      this.log('✓ Cleanup completed');
      
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
    
    if (error) {
      console.error(error);
      debug.error(message, error);
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  
  // Parse command line arguments
  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--validate-only') {
      options.validateOnly = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--table=')) {
      options.table = arg.split('=')[1];
    }
  }
  
  // Run migration
  const migration = new RethinkDBToPostgresMigration(options);
  
  migration.migrate()
    .then(() => {
      console.log('\n✓ Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Migration failed:', error.message);
      process.exit(1);
    });
}

module.exports = RethinkDBToPostgresMigration;