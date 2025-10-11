import chalk from 'chalk';
import debug from '../../util/debug.js';

export const logNotice = notice => {
  debug.tests(chalk.dim(notice));
};

export const logOK = notice => {
  debug.tests(`${chalk.green('✔')} ${notice}`);
};
