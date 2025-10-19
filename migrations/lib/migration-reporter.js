'use strict';

/**
 * Migration Reporter for RethinkDB to PostgreSQL Migration
 * 
 * Generates detailed reports about the migration process,
 * including statistics, performance metrics, and error summaries.
 */

const fs = require('fs').promises;
const path = require('path');

class MigrationReporter {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Generate a comprehensive migration report
   */
  async generateReport(stats, duration) {
    const report = {
      migration: {
        timestamp: new Date().toISOString(),
        duration: {
          milliseconds: Math.round(duration),
          seconds: Math.round(duration / 1000),
          minutes: Math.round(duration / 60000)
        },
        options: this.options
      },
      
      summary: {
        tablesProcessed: stats.tablesProcessed,
        recordsMigrated: stats.recordsMigrated,
        recordsSkipped: stats.recordsSkipped,
        errorsEncountered: stats.errors.length,
        success: stats.errors.length === 0
      },
      
      performance: {
        recordsPerSecond: Math.round(stats.recordsMigrated / (duration / 1000)),
        averageRecordsPerTable: Math.round(stats.recordsMigrated / Math.max(stats.tablesProcessed, 1))
      },
      
      errors: stats.errors.map(error => ({
        type: error.type,
        message: error.message,
        timestamp: error.timestamp,
        table: error.table || null,
        // Don't include full stack traces in the report for brevity
        hasStackTrace: !!error.stack
      })),
      
      recommendations: this.generateRecommendations(stats, duration)
    };
    
    return report;
  }

  /**
   * Generate recommendations based on migration results
   */
  generateRecommendations(stats, duration) {
    const recommendations = [];
    
    // Performance recommendations
    const recordsPerSecond = stats.recordsMigrated / (duration / 1000);
    if (recordsPerSecond < 100) {
      recommendations.push({
        type: 'performance',
        message: 'Migration speed is below 100 records/second. Consider increasing batch size or optimizing database connections.',
        priority: 'medium'
      });
    }
    
    // Error recommendations
    if (stats.errors.length > 0) {
      recommendations.push({
        type: 'errors',
        message: `${stats.errors.length} errors encountered during migration. Review error details and consider re-running failed operations.`,
        priority: 'high'
      });
    }
    
    // Success recommendations
    if (stats.errors.length === 0 && stats.recordsMigrated > 0) {
      recommendations.push({
        type: 'success',
        message: 'Migration completed successfully. Consider running validation tests and updating application configuration.',
        priority: 'low'
      });
    }
    
    // Data volume recommendations
    if (stats.recordsMigrated > 100000) {
      recommendations.push({
        type: 'monitoring',
        message: 'Large dataset migrated. Monitor PostgreSQL performance and consider optimizing indexes if queries are slow.',
        priority: 'medium'
      });
    }
    
    return recommendations;
  }

  /**
   * Generate a human-readable summary
   */
  generateSummary(report) {
    const lines = [];
    
    lines.push('='.repeat(60));
    lines.push('RETHINKDB TO POSTGRESQL MIGRATION REPORT');
    lines.push('='.repeat(60));
    lines.push('');
    
    // Basic info
    lines.push(`Migration completed: ${report.migration.timestamp}`);
    lines.push(`Duration: ${report.migration.duration.minutes} minutes ${report.migration.duration.seconds % 60} seconds`);
    lines.push(`Mode: ${report.migration.options.dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
    lines.push('');
    
    // Summary
    lines.push('SUMMARY:');
    lines.push(`  Tables processed: ${report.summary.tablesProcessed}`);
    lines.push(`  Records migrated: ${report.summary.recordsMigrated.toLocaleString()}`);
    lines.push(`  Records skipped: ${report.summary.recordsSkipped.toLocaleString()}`);
    lines.push(`  Errors encountered: ${report.summary.errorsEncountered}`);
    lines.push(`  Overall status: ${report.summary.success ? '✓ SUCCESS' : '✗ FAILED'}`);
    lines.push('');
    
    // Performance
    lines.push('PERFORMANCE:');
    lines.push(`  Records per second: ${report.performance.recordsPerSecond.toLocaleString()}`);
    lines.push(`  Average records per table: ${report.performance.averageRecordsPerTable.toLocaleString()}`);
    lines.push('');
    
    // Errors
    if (report.errors.length > 0) {
      lines.push('ERRORS:');
      report.errors.forEach((error, index) => {
        lines.push(`  ${index + 1}. [${error.type}] ${error.message}`);
        if (error.table) {
          lines.push(`     Table: ${error.table}`);
        }
        lines.push(`     Time: ${error.timestamp}`);
        lines.push('');
      });
    }
    
    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('RECOMMENDATIONS:');
      report.recommendations.forEach((rec, index) => {
        const priority = rec.priority.toUpperCase();
        lines.push(`  ${index + 1}. [${priority}] ${rec.message}`);
      });
      lines.push('');
    }
    
    lines.push('='.repeat(60));
    
    return lines.join('\n');
  }

  /**
   * Save report to files
   */
  async saveReport(report, baseDir = __dirname + '/..') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Save JSON report
    const jsonPath = path.join(baseDir, `migration-report-${timestamp}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    
    // Save human-readable summary
    const summary = this.generateSummary(report);
    const txtPath = path.join(baseDir, `migration-summary-${timestamp}.txt`);
    await fs.writeFile(txtPath, summary);
    
    return {
      jsonReport: jsonPath,
      textSummary: txtPath
    };
  }

  /**
   * Generate table-specific statistics
   */
  async generateTableStats(postgresDAL) {
    const tableStats = {};
    
    const tables = [
      'users', 'user_metas', 'teams', 'files', 'things', 'reviews',
      'blog_posts', 'invite_links', 'team_join_requests', 'team_slugs',
      'thing_slugs', 'team_members', 'team_moderators', 'review_teams',
      'thing_files'
    ];
    
    for (const tableName of tables) {
      try {
        const countResult = await postgresDAL.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        const count = parseInt(countResult.rows[0].count);
        
        tableStats[tableName] = {
          recordCount: count,
          status: 'success'
        };
        
        // Get additional stats for main tables
        if (['users', 'things', 'reviews', 'teams'].includes(tableName)) {
          const sizeResult = await postgresDAL.query(`
            SELECT pg_size_pretty(pg_total_relation_size('${tableName}')) as size
          `);
          tableStats[tableName].tableSize = sizeResult.rows[0].size;
        }
        
      } catch (error) {
        tableStats[tableName] = {
          recordCount: 0,
          status: 'error',
          error: error.message
        };
      }
    }
    
    return tableStats;
  }

  /**
   * Generate validation report
   */
  async generateValidationReport(validationResults) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        tablesValidated: Object.keys(validationResults).length,
        tablesValid: 0,
        tablesInvalid: 0,
        totalErrors: 0
      },
      tables: {}
    };
    
    for (const [tableName, result] of Object.entries(validationResults)) {
      report.tables[tableName] = {
        isValid: result.isValid,
        recordCount: result.recordCount,
        errorCount: result.errors.length,
        errors: result.errors
      };
      
      if (result.isValid) {
        report.summary.tablesValid++;
      } else {
        report.summary.tablesInvalid++;
        report.summary.totalErrors += result.errors.length;
      }
    }
    
    return report;
  }

  /**
   * Print progress update to console
   */
  printProgress(message, progress = null) {
    const timestamp = new Date().toISOString().substring(11, 19);
    let output = `[${timestamp}] ${message}`;
    
    if (progress !== null) {
      const percentage = Math.round(progress * 100);
      const bar = '█'.repeat(Math.round(progress * 20)) + '░'.repeat(20 - Math.round(progress * 20));
      output += ` [${bar}] ${percentage}%`;
    }
    
    console.log(output);
  }

  /**
   * Print error to console with formatting
   */
  printError(message, error = null) {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.error(`[${timestamp}] ✗ ERROR: ${message}`);
    
    if (error && this.options.verbose) {
      console.error(error);
    }
  }

  /**
   * Print success message to console
   */
  printSuccess(message) {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ✓ ${message}`);
  }
}

module.exports = MigrationReporter;