#!/usr/bin/env node
'use strict';

/**
 * Migration Rollback Utility
 * 
 * Provides rollback capabilities for the RethinkDB to PostgreSQL migration.
 * Can restore data from backup or clear PostgreSQL tables to revert migration.
 * 
 * Usage:
 *   node migrations/rollback-migration.js [options]
 * 
 * Options:
 *   --clear-postgres    Clear all data from PostgreSQL tables
 *   --restore-backup    Restore from backup (if backup exists)
 *   --table=NAME        Rollback only specific table
 *   --confirm           Skip confirmation prompt
 *   --dry-run           Show what would be rolled back without making changes
 */

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

// Database connections
const config = require('config');
const debug = require('../util/debug');

// PostgreSQL DAL
const PostgresDAL = require('../dal');

class MigrationRollback {
  constructor(options = {}) {
    this.options = {
      clearPostgres: options.clearPostgres || false,
      restoreBackup: options.restoreBackup || false,
      table: options.table || null,
      confirm: options.confirm || false,
      dryRun: options.dryRun || false,
      ...options
    };
    
    this.postgresDAL = null;
    
    this.stats = {
      startTime: null,
      endTime: null,
      tablesCleared: 0,
      recordsDeleted: 0,
      errors: []
    };
  }

  /**
   * Initialize database connections
   */
  async initialize() {
    this.log('Initializing rollback utility...');
    
    try {
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
      
    } catch (error) {
      this.error('Failed to initialize rollback utility:', error);
      throw error;
    }
  }

  /**
   * Execute the rollback process
   */
  async rollback() {
    this.stats.startTime = performance.now();
    
    try {
      await this.initialize();
      
      // Confirm rollback operation
      if (!this.options.confirm && !this.options.dryRun) {
        const confirmed = await this.confirmRollback();
        if (!confirmed) {
          this.log('Rollback cancelled by user');
          return;
        }
      }
      
      if (this.options.clearPostgres) {
        await this.clearPostgresTables();
      }
      
      if (this.options.restoreBackup) {
        await this.restoreFromBackup();
      }
      
      this.stats.endTime = performance.now();
      await this.generateRollbackReport();
      
    } catch (error) {
      this.stats.errors.push({
        type: 'rollback_error',
        message: error.message,
        stack: error.stack,
        timestamp: new Date()
      });
      
      this.error('Rollback failed:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Clear all PostgreSQL tables (reverse migration order)
   */
  async clearPostgresTables() {
    this.log('Clearing PostgreSQL tables...');
    
    // Clear in reverse dependency order
    const clearOrder = [
      // Join tables first
      'thing_files',
      'review_teams',
      'team_moderators',
      'team_members',
      // Then main tables in reverse dependency order
      'team_join_requests',
      'invite_links',
      'blog_posts',
      'reviews',
      'thing_slugs',
      'things',
      'files',
      'team_slugs',
      'teams',
      'user_metas',
      'users'
    ];
    
    // Filter to specific table if requested
    const tablesToClear = this.options.table 
      ? clearOrder.filter(table => table === this.options.table)
      : clearOrder;
    
    for (const tableName of tablesToClear) {
      await this.clearTable(tableName);
    }
    
    this.log(`✓ Cleared ${this.stats.tablesCleared} tables`);
  }

  /**
   * Clear a specific table
   */
  async clearTable(tableName) {
    try {
      // Check if table exists
      const tableExists = await this.checkTableExists(tableName);
      if (!tableExists) {
        this.log(`⚠ Table ${tableName} does not exist, skipping`);
        return;
      }
      
      // Get record count before clearing
      const countResult = await this.postgresDAL.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      const recordCount = parseInt(countResult.rows[0].count);
      
      if (recordCount === 0) {
        this.log(`✓ Table ${tableName} is already empty`);
        return;
      }
      
      this.log(`Clearing table ${tableName} (${recordCount} records)...`);
      
      if (!this.options.dryRun) {
        // Use TRUNCATE for better performance, CASCADE to handle foreign keys
        await this.postgresDAL.query(`TRUNCATE TABLE ${tableName} CASCADE`);
        
        // Reset sequences if they exist
        try {
          await this.postgresDAL.query(`
            SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), 1, false)
            WHERE pg_get_serial_sequence('${tableName}', 'id') IS NOT NULL
          `);
        } catch (error) {
          // Ignore sequence reset errors (table might not have auto-increment)
        }
      }
      
      this.stats.tablesCleared++;
      this.stats.recordsDeleted += recordCount;
      
      this.log(`✓ Cleared table ${tableName}`);
      
    } catch (error) {
      this.stats.errors.push({
        type: 'table_clear_error',
        table: tableName,
        message: error.message,
        timestamp: new Date()
      });
      
      this.error(`Failed to clear table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Check if a table exists in PostgreSQL
   */
  async checkTableExists(tableName) {
    try {
      const result = await this.postgresDAL.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )
      `, [tableName]);
      
      return result.rows[0].exists;
    } catch (error) {
      this.error(`Error checking table existence for ${tableName}:`, error);
      return false;
    }
  }

  /**
   * Restore from backup (placeholder for future implementation)
   */
  async restoreFromBackup() {
    this.log('Backup restoration not yet implemented');
    
    // This would be implemented to restore from:
    // 1. PostgreSQL dump files
    // 2. RethinkDB export files
    // 3. Custom backup format
    
    throw new Error('Backup restoration feature not yet implemented');
  }

  /**
   * Confirm rollback operation with user
   */
  async confirmRollback() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      console.log('\n⚠️  WARNING: This will permanently delete data from PostgreSQL!');
      console.log('Make sure you have a backup before proceeding.');
      console.log('');
      
      if (this.options.clearPostgres) {
        console.log('This operation will:');
        console.log('- Clear all data from PostgreSQL tables');
        console.log('- Reset auto-increment sequences');
        console.log('- Cannot be undone without a backup');
      }
      
      console.log('');
      
      rl.question('Are you sure you want to proceed? (type "yes" to confirm): ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'yes');
      });
    });
  }

  /**
   * Generate rollback report
   */
  async generateRollbackReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    
    const report = {
      rollback: {
        timestamp: new Date().toISOString(),
        duration: {
          milliseconds: Math.round(duration),
          seconds: Math.round(duration / 1000)
        },
        options: this.options
      },
      
      summary: {
        tablesCleared: this.stats.tablesCleared,
        recordsDeleted: this.stats.recordsDeleted,
        errorsEncountered: this.stats.errors.length,
        success: this.stats.errors.length === 0
      },
      
      errors: this.stats.errors.map(error => ({
        type: error.type,
        message: error.message,
        timestamp: error.timestamp,
        table: error.table || null
      }))
    };
    
    // Write report to file
    const reportPath = path.join(__dirname, '..', 'rollback-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    this.log(`\n--- Rollback Report ---`);
    this.log(`Duration: ${(duration / 1000).toFixed(2)} seconds`);
    this.log(`Tables cleared: ${this.stats.tablesCleared}`);
    this.log(`Records deleted: ${this.stats.recordsDeleted}`);
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
      
      this.log('✓ Cleanup completed');
      
    } catch (error) {
      this.error('Error during cleanup:', error);
    }
  }

  /**
   * Create backup before rollback
   */
  async createBackup() {
    this.log('Creating backup before rollback...');
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(__dirname, '..', 'backups');
      
      // Create backup directory if it doesn't exist
      try {
        await fs.mkdir(backupDir, { recursive: true });
      } catch (error) {
        // Directory might already exist
      }
      
      // Create PostgreSQL dump
      const dumpFile = path.join(backupDir, `postgres-backup-${timestamp}.sql`);
      
      // This would use pg_dump to create a backup
      // For now, just log the intended action
      this.log(`Backup would be created at: ${dumpFile}`);
      this.log('⚠ Automatic backup creation not yet implemented');
      this.log('Please create a manual backup using pg_dump before proceeding');
      
    } catch (error) {
      this.error('Failed to create backup:', error);
      throw error;
    }
  }

  /**
   * Validate rollback safety
   */
  async validateRollbackSafety() {
    const issues = [];
    
    try {
      // Check if RethinkDB is still accessible
      // (This would be important for data recovery)
      
      // Check PostgreSQL table sizes
      const tables = ['users', 'things', 'reviews', 'teams'];
      for (const table of tables) {
        try {
          const result = await this.postgresDAL.query(`SELECT COUNT(*) as count FROM ${table}`);
          const count = parseInt(result.rows[0].count);
          
          if (count > 10000) {
            issues.push(`Table ${table} has ${count} records - consider creating backup first`);
          }
        } catch (error) {
          // Table might not exist, which is fine
        }
      }
      
      // Check for foreign key constraints that might prevent cleanup
      const constraints = await this.postgresDAL.query(`
        SELECT conname, conrelid::regclass as table_name
        FROM pg_constraint
        WHERE contype = 'f'
        AND connamespace = 'public'::regnamespace
      `);
      
      if (constraints.rows.length > 0) {
        this.log(`Found ${constraints.rows.length} foreign key constraints (will use CASCADE)`);
      }
      
    } catch (error) {
      issues.push(`Validation error: ${error.message}`);
    }
    
    return issues;
  }

  /**
   * Log message with timestamp
   */
  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }

  /**
   * Log error message
   */
  error(message, error = null) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`);
    
    if (error) {
      console.error(error);
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  
  // Parse command line arguments
  for (const arg of args) {
    if (arg === '--clear-postgres') {
      options.clearPostgres = true;
    } else if (arg === '--restore-backup') {
      options.restoreBackup = true;
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--table=')) {
      options.table = arg.split('=')[1];
    }
  }
  
  // Validate options
  if (!options.clearPostgres && !options.restoreBackup) {
    console.error('Error: Must specify either --clear-postgres or --restore-backup');
    console.error('');
    console.error('Usage: node migrations/rollback-migration.js [options]');
    console.error('');
    console.error('Options:');
    console.error('  --clear-postgres    Clear all data from PostgreSQL tables');
    console.error('  --restore-backup    Restore from backup (if backup exists)');
    console.error('  --table=NAME        Rollback only specific table');
    console.error('  --confirm           Skip confirmation prompt');
    console.error('  --dry-run           Show what would be rolled back');
    process.exit(1);
  }
  
  // Run rollback
  const rollback = new MigrationRollback(options);
  
  rollback.rollback()
    .then(() => {
      console.log('\n✓ Rollback completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Rollback failed:', error.message);
      process.exit(1);
    });
}

module.exports = MigrationRollback;