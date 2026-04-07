const fs = require('fs');
const XLSX = require('xlsx');
const { isValidSalesforceIdentifier, isValidProfileName, RESTRICTED_SOBJECTS, RESTRICTED_FIELDS} = require("../utils/security");

async function convertExcelToConfig(excelPath) {
    try {
        console.log('📊 Salesforce Post-Deploy: Generate Config\n');
        console.log(`📂 Reading Excel file: ${excelPath}`);

        if (!fs.existsSync(excelPath)) {
            console.error(`❌ Excel file not found: ${excelPath}`);
            console.log('💡 Make sure post-deploy-tasks.xlsx exists in the current directory');
            process.exit(1);
        }

        const workbook = XLSX.readFile(excelPath);
        
        if (!workbook.Sheets['Tasks']) {
            console.error('❌ Sheet "Tasks" not found in Excel file');
            console.log('💡 Make sure your Excel file has a sheet named "Tasks"');
            process.exit(1);
        }

        const sheet = workbook.Sheets['Tasks'];
        const data = XLSX.utils.sheet_to_json(sheet);

        if (data.length === 0) {
            console.error('❌ No data found in Excel file');
            console.log('💡 Add at least one task to the "Tasks" sheet');
            process.exit(1);
        }

        const config = {
            fieldLevelSecurity: [],
            apexClassAccess: [],
            picklistValues: [],
            customRecords: []
        };

        let errors = [];
        let warnings = [];

        data.forEach((row, index) => {
            if (!row['Task Type']) return;
            
            const rowNum = index + 2; // Excel row number (header is row 1)

            try {
                switch (row['Task Type']) {
                    case 'FLS':
                        if (!row['Profile Name'] || !row['Object API Name'] || !row['Field API Name']) {
                            errors.push(`Row ${rowNum}: FLS task missing required fields (Profile, Object, or Field)`);
                            break;
                        }

                        // SECURITY: Validate profile names
                        let flsProfileList = String(row['Profile Name']).split(',').map(p => p.trim());
                        const invalidFlsProfiles = flsProfileList.filter(p => !isValidProfileName(p));
                        if (invalidFlsProfiles.length > 0) {
                            errors.push(`Row ${rowNum}: Invalid profile names: ${invalidFlsProfiles.join(', ')}`);
                            break;
                        }

                        // SECURITY: Validate object name
                        if (!isValidSalesforceIdentifier(row['Object API Name'])) {
                            errors.push(`Row ${rowNum}: Invalid object name: ${row['Object API Name']}`);
                            break;
                        }

                        // SECURITY: Validate field name
                        if (!isValidSalesforceIdentifier(row['Field API Name'])) {
                            errors.push(`Row ${rowNum}: Invalid field name: ${row['Field API Name']}`);
                            break;
                        }

                        config.fieldLevelSecurity.push({
                            object: row['Object API Name'],
                            field: row['Field API Name'],
                            profile: flsProfileList.length === 1 ? flsProfileList[0] : flsProfileList,
                            readable: String(row['Readable']).trim().toUpperCase() === 'TRUE',
                            editable: String(row['Editable']).trim().toUpperCase() === 'TRUE'
                        });
                        break;
                        
                    case 'ApexAccess':
                        if (!row['Profile Name'] || !row['Apex Class Name']) {
                            errors.push(`Row ${rowNum}: ApexAccess task missing required fields (Profile or Class Name)`);
                            break;
                        }

                        // SECURITY: Validate profile names
                        let apexProfileList = String(row['Profile Name']).split(',').map(p => p.trim());
                        const invalidApexProfiles = apexProfileList.filter(p => !isValidProfileName(p));
                        if (invalidApexProfiles.length > 0) {
                            errors.push(`Row ${rowNum}: Invalid profile names: ${invalidApexProfiles.join(', ')}`);
                            break;
                        }

                        // SECURITY: Validate class name
                        if (!isValidSalesforceIdentifier(row['Apex Class Name'])) {
                            errors.push(`Row ${rowNum}: Invalid class name: ${row['Apex Class Name']}`);
                            break;
                        }

                        config.apexClassAccess.push({
                            className: row['Apex Class Name'],
                            profile: apexProfileList.length === 1 ? apexProfileList[0] : apexProfileList,
                            enabled: String(row['Enabled']).trim().toUpperCase() === 'TRUE'
                        });
                        break;

                    case 'PicklistValue':
                        if (!row['Object API Name'] || !row['Field API Name'] || !row['Picklist Value']) {
                            errors.push(`Row ${rowNum}: PicklistValue task missing required fields`);
                            break;
                        }

                        // SECURITY: Validate object name
                        if (!isValidSalesforceIdentifier(row['Object API Name'])) {
                            errors.push(`Row ${rowNum}: Invalid object name: ${row['Object API Name']}`);
                            break;
                        }

                        // SECURITY: Validate field name
                        if (!isValidSalesforceIdentifier(row['Field API Name'])) {
                            errors.push(`Row ${rowNum}: Invalid field name: ${row['Field API Name']}`);
                            break;
                        }

                        // SECURITY: Check for path traversal
                        if (String(row['Object API Name']).includes('..') || 
                            String(row['Field API Name']).includes('..')) {
                            errors.push(`Row ${rowNum}: Path traversal attempt detected`);
                            break;
                        }

                        config.picklistValues.push({
                            object: row['Object API Name'],
                            field: row['Field API Name'],
                            value: String(row['Picklist Value']),
                            label: row['Picklist Label'] || row['Picklist Value'],
                            isActive: String(row['Is Active']).trim().toUpperCase() !== 'FALSE',
                            isDefault: String(row['Is Default']).trim().toUpperCase() === 'TRUE'
                        });
                        break;
                        
                    case 'Record':
                        if (!row['SObject Type'] || !row['Record Name']) {
                            errors.push(`Row ${rowNum}: Record task missing required fields`);
                            break;
                        }

                        // SECURITY: Check for restricted SObjects
                        if (RESTRICTED_SOBJECTS.includes(row['SObject Type'])) {
                            errors.push(`Row ${rowNum}: Restricted SObject type: ${row['SObject Type']}`);
                            break;
                        }

                        // SECURITY: Validate SObject name
                        if (!isValidSalesforceIdentifier(row['SObject Type'])) {
                            errors.push(`Row ${rowNum}: Invalid SObject name: ${row['SObject Type']}`);
                            break;
                        }

                        const recordData = {
                            Name: row['Record Name']
                        };
                        
                        if (row['Additional Fields (JSON)']) {
                            try {
                                const additionalFields = JSON.parse(row['Additional Fields (JSON)']);
                                
                                // SECURITY: Check for restricted fields
                                const restrictedFieldsPresent = Object.keys(additionalFields).filter(key => 
                                    RESTRICTED_FIELDS.includes(key) || key.startsWith('__')
                                );

                                if (restrictedFieldsPresent.length > 0) {
                                    errors.push(`Row ${rowNum}: Restricted fields: ${restrictedFieldsPresent.join(', ')}`);
                                    break;
                                }

                                // SECURITY: Validate field names
                                const invalidFieldNames = Object.keys(additionalFields).filter(key => 
                                    !isValidSalesforceIdentifier(key)
                                );

                                if (invalidFieldNames.length > 0) {
                                    errors.push(`Row ${rowNum}: Invalid field names: ${invalidFieldNames.join(', ')}`);
                                    break;
                                }

                                Object.assign(recordData, additionalFields);
                            } catch (e) {
                                errors.push(`Row ${rowNum}: Invalid JSON in Additional Fields`);
                            }
                        }

                        // SECURITY: Validate operation
                        const operation = (row['Operation'] || 'create').toLowerCase();
                        if (operation === 'delete') {
                            warnings.push(`Row ${rowNum}: Delete operations are disabled for security`);
                            break;
                        }
                        if (!['create', 'update'].includes(operation)) {
                            errors.push(`Row ${rowNum}: Invalid operation: ${operation}`);
                            break;
                        }
                        
                        config.customRecords.push({
                            sObject: row['SObject Type'],
                            operation: operation,
                            data: recordData
                        });
                        break;

                    default:
                        errors.push(`Row ${rowNum}: Unknown Task Type "${row['Task Type']}"`);
                }
            } catch (error) {
                errors.push(`Row ${rowNum}: ${error.message}`);
            }
        });

        // Show warnings
        if (warnings.length > 0) {
            console.log('\n⚠️  Warnings:\n');
            warnings.forEach(warn => console.log(`   ${warn}`));
        }

        // Show errors if any
        if (errors.length > 0) {
            console.error('\n❌ Found errors in Excel file:\n');
            errors.forEach(err => console.error(`   ${err}`));
            console.log('\n💡 Fix the errors in your Excel file and run the command again');
            process.exit(1);
        }

        // Write config.json
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        
        console.log('\n✅ Successfully generated config.json\n');
        console.log('📋 Summary:');
        console.log(`   - ${config.fieldLevelSecurity.length} Field Level Security tasks`);
        console.log(`   - ${config.apexClassAccess.length} Apex Class Access tasks`);
        console.log(`   - ${config.picklistValues.length} Picklist Value tasks`);
        console.log(`   - ${config.customRecords.length} Custom Record tasks`);
        console.log(`   - Total: ${data.length} tasks\n`);
        console.log('🚀 Next step: pd start post-deployment <org-alias>');

    } catch (error) {
        console.error('❌ Error generating config:', error.message);
        process.exit(1);
    }
}

module.exports = { convertExcelToConfig };