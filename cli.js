const { Command } = require('commander');
const { convertExcelToConfig } = require('./commands/generate');
const { startDeployment } = require('./commands/deploy');
const packageJson = require('./package.json');

const program = new Command();

program
  .name('pd')
  .description('Salesforce Post-Deployment Automation CLI')
  .version(packageJson.version);

// Command: pd generate config-from-excel
program
  .command('generate')
  .argument('<type>', 'Type of generation (config-from-excel)')
  .description('Generate config.json from Excel template')
  .option('-f, --file <path>', 'Path to Excel file', './post-deploy-tasks.xlsx')
  .action(async (type, options) => {
    if (type === 'config-from-excel') {
      await convertExcelToConfig(options.file);
    } else {
      console.error(`❌ Unknown generation type: ${type}`);
      console.log('💡 Try: pd generate config-from-excel');
      process.exit(1);
    }
  });

// Command: pd start post-deployment <org-alias>
program
  .command('start')
  .argument('<type>', 'Type of task (post-deployment)')
  .argument('<org-alias>', 'Salesforce org alias')
  .description('Start post-deployment tasks')
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .action(async (type, orgAlias, options) => {
    if (type === 'post-deployment') {
      await startDeployment(orgAlias, options.config);
    } else {
      console.error(`❌ Unknown task type: ${type}`);
      console.log('💡 Try: pd start post-deployment <org-alias>');
      process.exit(1);
    }
  });

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

program.parse(process.argv);