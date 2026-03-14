const XLSX = require('xlsx');
const fs = require('fs');

const workbook = XLSX.readFile('./post-deploy-tasks.xlsx');
const sheet = workbook.Sheets['Tasks'];
const data = XLSX.utils.sheet_to_json(sheet);

const config = {
    fieldLevelSecurity: [],
    apexClassAccess: [],
    customRecords: [],
    picklistValues: []
};

data.forEach(row => {
    if (!row['Task Type']) return; // Skip empty rows
    
    switch (row['Task Type']) {
        case 'FLS':
            config.fieldLevelSecurity.push({
                object: row['Object API Name'],
                field: row['Field API Name'],
                profile: row['Profile Name'],
                readable: String(row['Readable']).toUpperCase() === 'TRUE',
                editable: String(row['Editable']).toUpperCase() === 'TRUE'
            });
            break;
            
        case 'ApexAccess':
            config.apexClassAccess.push({
                className: row['Apex Class Name'],
                profile: row['Profile Name'],
                enabled: String(row['Enabled']).toUpperCase() === 'TRUE'
            });
            break;
        
        case 'PicklistValue':
            config.picklistValues.push({
                object: row['Object API Name'],
                field: row['Field API Name'],
                value: row['Picklist Value'],
                label: row['Picklist Label'] || row['Picklist Value'],
                isActive: String(row['Is Active']).toUpperCase() === 'TRUE',
                isDefault: String(row['Is Default']).toUpperCase() === 'TRUE'
            });
            break;
            
        case 'Record':
            const recordData = {
                Name: row['Record Name'],
                ...(row['Additional Fields (JSON)'] && JSON.parse(row['Additional Fields (JSON)']))
            };
            
            config.customRecords.push({
                sObject: row['SObject Type'],
                data: recordData
            });
            break;
    }
});

fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
console.log(`✅ Generated config.json with:`);
console.log(`   - ${config.fieldLevelSecurity.length} FLS tasks`);
console.log(`   - ${config.apexClassAccess.length} Apex Access tasks`);
console.log(`   - ${config.picklistValues.length} Picklist Value tasks`);
console.log(`   - ${config.customRecords.length} Custom Record tasks`);