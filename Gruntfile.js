'use strict';

const saveLicense = require('uglify-save-license');

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    copy: {
      main: {
        expand: true,
        flatten: true,
        src: [
          'node_modules/jquery/dist/jquery.js',
          'node_modules/sisyphus.js/sisyphus.js',
          'frontend/lib/ac.js',
          'node_modules/jquery-powertip/dist/jquery.powertip.js',
          'node_modules/jquery-modal/jquery.modal.js'
        ],
        dest: 'static/js/'
      },
      editorStyles: {
        expand: true,
        flatten: true,
        src: [
          'node_modules/prosemirror-view/style/prosemirror.css',
          'node_modules/prosemirror-menu/style/menu.css'
        ],
        dest: 'static/css/editor/'
      }
    },
    browserify: {
      editor: {
        src: 'frontend/editor.js',
        dest: 'build/editor-es6-bundle.js'
      },
      review: {
        src: 'frontend/review.js',
        dest: 'build/review-es6-bundle.js'
      }
    },
    babel: {
      mainJS: {
        options: {
          sourceMaps: true,
          presets: ['@babel/preset-env']
        },
        files: {
          'static/js/libreviews.js': 'frontend/libreviews.js',
          'static/js/register.js': 'frontend/register.js',
          'static/js/review.js': 'build/review-es6-bundle.js',
          'static/js/upload.js': 'frontend/upload.js',
          'static/js/user.js': 'frontend/user.js',
          'static/js/manage-urls.js': 'frontend/manage-urls.js',
          'static/js/editor.js': 'build/editor-es6-bundle.js'
        }
      }
    },
    concat: {
      libJS: {
        src: [
          'static/js/jquery.js',
          'static/js/jquery.powertip.js',
          'static/js/jquery.modal.js',
          'static/js/sisyphus.js',
          'static/js/ac.js',
          'static/js/libreviews.js'
        ],
        dest: 'static/js/lib.js'
      },
    },
    uglify: {
      options: {
        preserveComments: saveLicense
      },
      mainJS: {
        files: {
          'static/js/lib.min.js': ['static/js/lib.js'],
          'static/js/editor.min.js': ['static/js/editor.js']
        }
      },
    }
  });

  grunt.registerTask('default', ['copy', 'browserify', 'babel', 'concat', 'uglify']);

};
