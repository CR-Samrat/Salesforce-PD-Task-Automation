const fs = require('fs');
const { Org } = require('@salesforce/core');
const {
    escapeSoqlString,
    escapeSoqlArray,
    isValidSalesforceIdentifier,
    isValidProfileName,
    isValidSalesforceId,
    containsPathTraversal,
    RESTRICTED_SOBJECTS,
    RESTRICTED_FIELDS
} = require('../utils/security');

async function startDeployment(orgAlias, configPath) {
    try {
        console.log('🚀 Salesforce Post-Deploy: Start Deployment\n');

        // Check if config exists
        if (!fs.existsSync(configPath)) {
            console.error(`❌ Config file not found: ${configPath}`);
            console.log('💡 Run "pd generate config-from-excel" first');
            process.exit(1);
        }

        // Connect to Salesforce
        console.log(`📡 Connecting to org: ${orgAlias}...`);
        const org = await Org.create({ aliasOrUsername: orgAlias });
        const connection = org.getConnection();
        console.log(`✅ Connected successfully!\n`);

        // Load config
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        // Validate config
        const totalTasks = 
            (config.fieldLevelSecurity?.length || 0) +
            (config.apexClassAccess?.length || 0) +
            (config.picklistValues?.length || 0) +
            (config.customRecords?.length || 0);

        if (totalTasks === 0) {
            console.error('❌ No tasks found in config.json');
            console.log('💡 Make sure your Excel file has tasks and regenerate config');
            process.exit(1);
        }

        console.log('📋 Loaded configuration:');
        console.log(`   - ${config.fieldLevelSecurity?.length || 0} FLS tasks`);
        console.log(`   - ${config.apexClassAccess?.length || 0} Apex Access tasks`);
        console.log(`   - ${config.picklistValues?.length || 0} Picklist Value tasks`);
        console.log(`   - ${config.customRecords?.length || 0} Record Creation tasks`);
        console.log(`   - Total: ${totalTasks} tasks\n`);

        // Execute tasks
        if (config.fieldLevelSecurity && config.fieldLevelSecurity.length > 0) {
            await updateFieldLevelSecurity(connection, config.fieldLevelSecurity);
        }

        if (config.apexClassAccess && config.apexClassAccess.length > 0) {
            await updateApexClassAccess(connection, config.apexClassAccess);
        }

        if (config.picklistValues && config.picklistValues.length > 0) {
            await addPicklistValues(connection, config.picklistValues);
        }

        if (config.customRecords && config.customRecords.length > 0) {
            await createCustomRecords(connection, config.customRecords);
        }

        console.log('\n✅ All post-deployment tasks completed successfully!');
        console.log('🎉 Deployment complete!\n');

    } catch (error) {
        if (error.name === 'NamedOrgNotFound') {
            console.error(`❌ Org not found: ${orgAlias}`);
            console.log('💡 Make sure you\'re logged in: sf org login web --alias ' + orgAlias);
        } else {
            console.error('❌ Deployment error:', error.message);
        }
        process.exit(1);
    }
}

async function updateFieldLevelSecurity(connection, flsConfig) {
    console.log('🔐 Updating Field Level Security...');

    for (const fls of flsConfig) {
        try {
            // Normalize profile list
            const profiles = Array.isArray(fls.profile) 
                ? fls.profile 
                : fls.profile.split(',').map(p => p.trim());

            // SECURITY: Validate all profiles
            const invalidProfiles = profiles.filter(p => !isValidProfileName(p));
            if (invalidProfiles.length > 0) {
                console.log(`   ⚠️ Invalid profile names: ${invalidProfiles.join(', ')}. Skipping.`);
                continue;
            }

            // SECURITY: Validate object name
            if (!isValidSalesforceIdentifier(fls.object)) {
                console.log(`   ⚠️ Invalid object name: ${fls.object}. Skipping.`);
                continue;
            }

            // SECURITY: Validate field name
            if (!isValidSalesforceIdentifier(fls.field)) {
                console.log(`   ⚠️ Invalid field name: ${fls.field}. Skipping.`);
                continue;
            }

            console.log(`   - ${fls.object}.${fls.field} for Profiles: ${profiles.join(', ')}`);

            // SECURITY: Escape profile names for SOQL
            const escapedProfiles = escapeSoqlArray(profiles);
            const psQuery = `
                SELECT Id, Name, ProfileId, Profile.Name
                FROM PermissionSet
                WHERE Profile.Name IN ('${escapedProfiles.join("','")}')
                AND IsOwnedByProfile = true
            `;
            const psResult = await connection.query(psQuery);

            if (psResult.records.length === 0) {
                console.log(`   ⚠️ No matching PermissionSets found for profiles. Skipping.`);
                continue;
            }

            const permissionSetIds = psResult.records.map(r => r.Id);
            
            // SECURITY: Escape object and field names
            const escapedObject = escapeSoqlString(fls.object);
            const escapedField = escapeSoqlString(fls.field);
            
            const fpQuery = `
                SELECT Id, ParentId, PermissionsRead, PermissionsEdit
                FROM FieldPermissions
                WHERE ParentId IN ('${permissionSetIds.join("','")}')
                AND SobjectType = '${escapedObject}'
                AND Field = '${escapedObject}.${escapedField}'
            `;
            const fpResult = await connection.query(fpQuery);

            const existingMap = new Map();
            fpResult.records.forEach(fp => existingMap.set(fp.ParentId, fp));

            const toUpdate = [];
            const toInsert = [];

            for (const ps of psResult.records) {
                const existing = existingMap.get(ps.Id);
                if (existing) {
                    const needsUpdate =
                        existing.PermissionsRead !== fls.readable ||
                        existing.PermissionsEdit !== fls.editable;
                    if (needsUpdate) {
                        toUpdate.push({
                            Id: existing.Id,
                            PermissionsRead: fls.readable,
                            PermissionsEdit: fls.editable
                        });
                    } else {
                        console.log(`   ℹ️  ${ps.Profile.Name} already has desired settings`);
                    }
                } else {
                    toInsert.push({
                        ParentId: ps.Id,
                        SobjectType: fls.object,
                        Field: `${fls.object}.${fls.field}`,
                        PermissionsRead: fls.readable,
                        PermissionsEdit: fls.editable
                    });
                }
            }

            if (toUpdate.length > 0) {
                await connection.sobject('FieldPermissions').update(toUpdate);
                console.log(`   ✅ Updated ${toUpdate.length} field permissions`);
            }
            if (toInsert.length > 0) {
                await connection.sobject('FieldPermissions').create(toInsert);
                console.log(`   ✅ Created ${toInsert.length} field permissions`);
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
}

async function updateApexClassAccess(connection, apexConfig) {
    console.log('\n📦 Updating Apex Class Access...');

    for (const apex of apexConfig) {
        try {
            const profiles = Array.isArray(apex.profile) 
                ? apex.profile 
                : apex.profile.split(',').map(p => p.trim());

            // SECURITY: Validate profiles
            const invalidProfiles = profiles.filter(p => !isValidProfileName(p));
            if (invalidProfiles.length > 0) {
                console.log(`   ⚠️ Invalid profile names: ${invalidProfiles.join(', ')}. Skipping.`);
                continue;
            }

            // SECURITY: Validate class name
            if (!isValidSalesforceIdentifier(apex.className)) {
                console.log(`   ⚠️ Invalid class name: ${apex.className}. Skipping.`);
                continue;
            }

            console.log(`   - ${apex.className} for Profiles: ${profiles.join(', ')}`);

            // SECURITY: Escape for SOQL
            const escapedProfiles = escapeSoqlArray(profiles);
            const psQuery = `
                SELECT Id, Name, Profile.Name
                FROM PermissionSet
                WHERE Profile.Name IN ('${escapedProfiles.join("','")}')
                AND IsOwnedByProfile = true
            `;
            const psResult = await connection.query(psQuery);

            if (psResult.records.length === 0) {
                console.log(`   ⚠️ No matching PermissionSets found for profiles. Skipping.`);
                continue;
            }

            // SECURITY: Escape class name
            const escapedClassName = escapeSoqlString(apex.className);
            const classQuery = `SELECT Id FROM ApexClass WHERE Name = '${escapedClassName}'`;
            const classResult = await connection.query(classQuery);

            if (classResult.records.length === 0) {
                console.log(`   ⚠️ Apex Class '${apex.className}' not found. Skipping.`);
                continue;
            }
            const apexClassId = classResult.records[0].Id;

            const permissionSetIds = psResult.records.map(r => r.Id);
            const seaQuery = `
                SELECT Id, ParentId
                FROM SetupEntityAccess
                WHERE ParentId IN ('${permissionSetIds.join("','")}')
                AND SetupEntityId = '${apexClassId}'
            `;
            const seaResult = await connection.query(seaQuery);

            const existingMap = new Map();
            seaResult.records.forEach(sea => existingMap.set(sea.ParentId, sea));

            const toInsert = [];
            const toDelete = [];

            for (const ps of psResult.records) {
                const existing = existingMap.get(ps.Id);
                if (apex.enabled) {
                    if (!existing) {
                        toInsert.push({
                            ParentId: ps.Id,
                            SetupEntityId: apexClassId
                        });
                    } else {
                        console.log(`   ℹ️  ${ps.Profile.Name} already has access`);
                    }
                } else {
                    if (existing) {
                        toDelete.push(existing.Id);
                    } else {
                        console.log(`   ℹ️  ${ps.Profile.Name} already has no access`);
                    }
                }
            }

            if (toInsert.length > 0) {
                await connection.sobject('SetupEntityAccess').create(toInsert);
                console.log(`   ✅ Granted access for ${toInsert.length} profiles`);
            }
            if (toDelete.length > 0) {
                await connection.sobject('SetupEntityAccess').delete(toDelete);
                console.log(`   ✅ Revoked access for ${toDelete.length} profiles`);
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
}

async function addPicklistValues(connection, picklistConfig) {
    console.log('\n📝 Adding Picklist Values...');

    for (const picklist of picklistConfig) {
        try {
            // SECURITY: Validate object and field
            if (!isValidSalesforceIdentifier(picklist.object)) {
                console.log(`   ⚠️ Invalid object name: ${picklist.object}. Skipping.`);
                continue;
            }

            if (!isValidSalesforceIdentifier(picklist.field)) {
                console.log(`   ⚠️ Invalid field name: ${picklist.field}. Skipping.`);
                continue;
            }

            // SECURITY: Check for path traversal
            if (containsPathTraversal(picklist.object) || containsPathTraversal(picklist.field)) {
                console.log(`   ⚠️ Path traversal attempt detected. Skipping.`);
                continue;
            }

            console.log(`   - ${picklist.object}.${picklist.field}: Adding "${picklist.value}"`);

            // SECURITY: Escape for SOQL
            const escapedObject = escapeSoqlString(picklist.object);
            const escapedField = escapeSoqlString(picklist.field);

            const fieldQuery = `
                SELECT Id, QualifiedApiName, DurableId 
                FROM FieldDefinition 
                WHERE EntityDefinition.QualifiedApiName = '${escapedObject}' 
                AND QualifiedApiName = '${escapedField}'
            `;
            
            const fieldResult = await connection.query(fieldQuery);

            if (fieldResult.records.length === 0) {
                console.log(`   ⚠️  Field not found. Skipping.`);
                continue;
            }

            const durableId = fieldResult.records[0].DurableId;

            // SECURITY: Escape picklist value
            const escapedValue = escapeSoqlString(picklist.value);
            const valueQuery = `
                SELECT Id, Value, IsActive 
                FROM PicklistValueInfo 
                WHERE EntityParticleId = '${durableId}' 
                AND Value = '${escapedValue}'
            `;

            const valueResult = await connection.query(valueQuery);

            if (valueResult.records.length > 0) {
                await updatePicklistValue(connection, picklist);
                continue;
            }

            await deployPicklistValue(connection, picklist);

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
}

async function deployPicklistValue(connection, picklist) {
    try {
        let readResult = await connection.metadata.read('CustomField', 
            `${picklist.object}.${picklist.field}`
        );

        // Handle array response
        if (Array.isArray(readResult)) {
            readResult = readResult[0];
        }

        if (!readResult || !readResult.valueSet) {
            console.log(`   ⚠️  Field is not a picklist or doesn't exist`);
            return;
        }

        const existingValues = readResult.valueSet.valueSetDefinition?.value || [];
        const valueExists = existingValues.some(v => v.fullName === picklist.value);

        if (valueExists) {
            console.log(`   ℹ️  Value "${picklist.value}" already exists`);
            await updatePicklistValue(connection, picklist);
            return;
        }

        const newValue = {
            fullName: picklist.value,
            label: picklist.label || picklist.value,
            default: picklist.isDefault || false,
            isActive: picklist.isActive !== false
        };

        existingValues.push(newValue);
        readResult.valueSet.valueSetDefinition.value = existingValues;

        // Update the field
        const updateResult = await connection.metadata.update('CustomField', readResult);

        if (updateResult.success) {
            console.log(`   ✅ Added picklist value "${picklist.value}"`);
        } else {
            console.log(`   ❌ Failed to add value: ${updateResult.errors?.join(', ')}`);
        }

    } catch (error) {
        console.log(`   ❌ Metadata deployment failed: ${error.message}`);
    }
}

async function updatePicklistValue(connection, picklist) {
    try {
        let readResult = await connection.metadata.read(
            'CustomField',
            `${picklist.object}.${picklist.field}`
        );

        // Handle array response
        if (Array.isArray(readResult)) {
            readResult = readResult[0];
        }

        if (!readResult || !readResult.valueSet) {
            console.log(`   ⚠️  Field is not a picklist or doesn't exist`);
            return;
        }

        const existingValues = readResult.valueSet.valueSetDefinition?.value || [];
        const targetIndex = existingValues.findIndex(v => v.fullName === picklist.value);

        if (targetIndex === -1) {
            console.log(`   ❌ Value "${picklist.value}" not found`);
            return;
        }

        // Update the existing value
        existingValues[targetIndex] = {
            ...existingValues[targetIndex],
            label: picklist.label || existingValues[targetIndex].label,
            default: picklist.isDefault ?? existingValues[targetIndex].default,
            isActive: picklist.isActive ?? existingValues[targetIndex].isActive
        };

        // Replace the full array
        readResult.valueSet.valueSetDefinition.value = existingValues;

        // Push update
        const updateResult = await connection.metadata.update('CustomField', readResult);

        if (updateResult.success) {
            console.log(`   ✅ Updated picklist value "${picklist.value}"`);
        } else {
            console.log(`   ❌ Failed to update value: ${updateResult.errors?.join(', ')}`);
        }

    } catch (error) {
        console.log(`   ❌ Metadata update failed: ${error.message}`);
    }
}

async function createCustomRecords(connection, recordsConfig) {
    console.log('\n📝 Creating Custom Records...');

    for (const record of recordsConfig) {
        try {
            // SECURITY: Check for restricted SObjects
            if (RESTRICTED_SOBJECTS.includes(record.sObject)) {
                console.log(`   ⚠️  Restricted SObject: ${record.sObject}. Skipping for security.`);
                continue;
            }

            // SECURITY: Validate SObject name
            if (!isValidSalesforceIdentifier(record.sObject)) {
                console.log(`   ⚠️  Invalid SObject name: ${record.sObject}. Skipping.`);
                continue;
            }

        console.log(`   - ${record.sObject}: ${record.data.Name || 'Record'}`);
            
        const operation = (record?.operation || 'create').toLowerCase();

            // SECURITY: Disable delete operations
            if (operation === 'delete') {
                console.log(`   ⚠️  Delete operations are disabled for security. Skipping.`);
            continue;
        }

            if (!['create', 'update'].includes(operation)) {
                console.log(`   ⚠️  Invalid operation: ${operation}. Skipping.`);
                continue;
            }

            if (operation === 'update') {
                if (!record.data.Id) {
                    console.log(`   ⚠️  Update requires an Id field. Skipping.`);
                    continue;
                }

                // SECURITY: Validate Salesforce ID format
                if (!isValidSalesforceId(record.data.Id)) {
                    console.log(`   ⚠️  Invalid Salesforce ID format. Skipping.`);
                    continue;
                }
            }

            // SECURITY: Check for restricted fields in data
            const restrictedFieldsPresent = Object.keys(record.data).filter(key => 
                RESTRICTED_FIELDS.includes(key) || key.startsWith('__')
            );

            if (restrictedFieldsPresent.length > 0) {
                console.log(`   ⚠️  Restricted fields detected: ${restrictedFieldsPresent.join(', ')}. Skipping.`);
                continue;
            }

            let result;
            if (operation === 'create') {
                result = await connection.sobject(record.sObject).create(record.data);
            } else if (operation === 'update') {
                result = await connection.sobject(record.sObject).update(record.data);
            }

            if (result?.success) {
                console.log(`   ✅ ${operation.charAt(0).toUpperCase() + operation.slice(1)} successful (ID: ${result.id || record.data.Id})`);
            } else {
                const errors = Array.isArray(result?.errors) 
                    ? result.errors.map(e => e.message || e).join(', ')
                    : 'Unknown error';
                console.log(`   ❌ Failed: ${errors}`);
            }
        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
}

module.exports = { startDeployment };