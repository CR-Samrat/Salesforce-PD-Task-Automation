const { Org } = require('@salesforce/core');
const fs = require('fs');

async function main() {
    try {
        console.log('🚀 Starting post-deployment tasks...\n');

        // 1. Get org alias from command line argument or use default
        const orgAlias = process.argv[2] || 'your-dev-org-alias';
        console.log(`📡 Connecting to org: ${orgAlias}`);

        // 2. Connect to Salesforce org using existing authentication
        const org = await Org.create({ aliasOrUsername: orgAlias });
        const connection = org.getConnection();
        console.log(`✅ Connected successfully!\n`);

        // 3. Read configuration file
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        console.log('📋 Configuration loaded\n');

        // 4. Execute tasks based on config
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

    } catch (error) {
        console.error('❌ Error during post-deployment:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

async function updateFieldLevelSecurity(connection, flsConfig) {
    console.log('🔐 Updating Field Level Security...');

    for (const fls of flsConfig) {
        try {
            console.log(`   - ${fls.object}.${fls.field} for Profile: ${fls.profile}`);

            // Find the Profile's associated Permission Set
            const psQuery = `
                SELECT Id, Name, ProfileId, Profile.Name 
                FROM PermissionSet 
                WHERE Profile.Name = '${fls.profile}' 
                AND IsOwnedByProfile = true
            `;
            const psResult = await connection.query(psQuery);

            if (psResult.records.length === 0) {
                console.log(`   ⚠️  Profile '${fls.profile}' or its Permission Set not found. Skipping.`);
                continue;
            }

            const permissionSetId = psResult.records[0].Id;

            // Query to find if FieldPermissions already exists
            const fpQuery = `
                SELECT Id, PermissionsRead, PermissionsEdit 
                FROM FieldPermissions 
                WHERE ParentId = '${permissionSetId}' 
                AND SobjectType = '${fls.object}' 
                AND Field = '${fls.object}.${fls.field}'
            `;
            const fpResult = await connection.query(fpQuery);

            if (fpResult.records.length > 0) {
                // Update existing FieldPermissions
                const extFieldPermission = fpResult.records[0];
                const fieldPermissionId = extFieldPermission.Id;
                const needsUpdate = extFieldPermission.PermissionsRead !== fls.readable ||
                                    extFieldPermission.PermissionsEdit !== fls.editable;

                if (!needsUpdate) {
                    console.log(`   ℹ️  Field permissions already have desired settings`);
                    continue;
                }

                await connection.sobject('FieldPermissions').update({
                    Id: fieldPermissionId,
                    PermissionsRead: fls.readable,
                    PermissionsEdit: fls.editable
                });
                console.log(`   ✅ Updated field permissions`);
            } else {
                // Create new FieldPermissions
                await connection.sobject('FieldPermissions').create({
                    ParentId: permissionSetId,
                    SobjectType: fls.object,
                    Field: `${fls.object}.${fls.field}`,
                    PermissionsRead: fls.readable,
                    PermissionsEdit: fls.editable
                });
                console.log(`   ✅ Created field permissions`);
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
            console.log(`   - ${apex.className} for Profile: ${apex.profile}`);

            // Find the Profile's associated Permission Set
            const psQuery = `
                SELECT Id, Name, ProfileId, Profile.Name 
                FROM PermissionSet 
                WHERE Profile.Name = '${apex.profile}' 
                AND IsOwnedByProfile = true
            `;
            const psResult = await connection.query(psQuery);

            if (psResult.records.length === 0) {
                console.log(`   ⚠️  Profile '${apex.profile}' or its Permission Set not found. Skipping.`);
                continue;
            }

            const permissionSetId = psResult.records[0].Id;

            // Query to find the Apex Class
            const classQuery = `SELECT Id FROM ApexClass WHERE Name = '${apex.className}'`;
            const classResult = await connection.query(classQuery);

            if (classResult.records.length === 0) {
                console.log(`   ⚠️  Apex Class '${apex.className}' not found. Skipping.`);
                continue;
            }

            const apexClassId = classResult.records[0].Id;

            // Query to find if SetupEntityAccess already exists
            const seaQuery = `
                SELECT Id 
                FROM SetupEntityAccess 
                WHERE ParentId = '${permissionSetId}' 
                AND SetupEntityId = '${apexClassId}'
            `;
            const seaResult = await connection.query(seaQuery);

            if (apex.enabled && seaResult.records.length === 0) {
                // Create access if enabled and doesn't exist
                await connection.sobject('SetupEntityAccess').create({
                    ParentId: permissionSetId,
                    SetupEntityId: apexClassId
                });
                console.log(`   ✅ Granted access`);
            } else if (!apex.enabled && seaResult.records.length > 0) {
                // Remove access if disabled and exists
                await connection.sobject('SetupEntityAccess').delete(seaResult.records[0].Id);
                console.log(`   ✅ Revoked access`);
            } else {
                console.log(`   ℹ️  Already in desired state`);
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
            console.log(`   - ${picklist.object}.${picklist.field}: Adding "${picklist.value}"`);

            // Step 1: Get the field's metadata to find the picklist
            const fieldQuery = `
                SELECT Id, QualifiedApiName, DurableId 
                FROM FieldDefinition 
                WHERE EntityDefinition.QualifiedApiName = '${picklist.object}' 
                AND QualifiedApiName = '${picklist.field}'
            `;
            
            const fieldResult = await connection.query(fieldQuery);

            if (fieldResult.records.length === 0) {
                console.log(`   ⚠️  Field '${picklist.object}.${picklist.field}' not found. Skipping.`);
                continue;
            }

            const durableId = fieldResult.records[0].DurableId;

            // Step 2: Check if the picklist value already exists
            const valueQuery = `
                SELECT Id, Value, IsActive 
                FROM PicklistValueInfo 
                WHERE EntityParticleId = '${durableId}' 
                AND Value = '${picklist.value}'
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
        const readResult = await connection.metadata.read('CustomField', 
            `${picklist.object}.${picklist.field}`
        );

        if (!readResult || !readResult.valueSet) {
            console.log(`   ⚠️  Field is not a picklist or doesn't exist`);
            return;
        }

        // Check if value already exists
        const existingValues = readResult.valueSet.valueSetDefinition?.value || [];
        const valueExists = existingValues.some(v => v.fullName === picklist.value);

        if (valueExists) {
            console.log(`   ℹ️  Value "${picklist.value}" already exists`);
            await updatePicklistValue(connection, picklist);
            return;
        }

        // Add new value
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
        const readResult = await connection.metadata.read(
            'CustomField',
            `${picklist.object}.${picklist.field}`
        );

        if (!readResult || !readResult.valueSet) {
            console.log(`⚠️ Field is not a picklist or doesn't exist`);
            return;
        }

        const existingValues = readResult.valueSet.valueSetDefinition?.value || [];
        const targetIndex = existingValues.findIndex(v => v.fullName === picklist.value);

        if (targetIndex === -1) {
            console.log(`❌ Value "${picklist.value}" not found`);
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
            console.log(`✅ Updated picklist value "${picklist.value}"`);
        } else {
            console.log(`❌ Failed to update value: ${updateResult.errors?.join(', ')}`);
        }

    } catch (error) {
        console.log(`❌ Metadata update failed: ${error.message}`);
    }
}

async function createCustomRecords(connection, recordsConfig) {
    console.log('\n📝 Creating Custom Records...');

    for (const record of recordsConfig) {
        console.log(`   - ${record.sObject}: ${record.data.Name || 'Record'}`);
            
        const operation = (record?.operation || 'create').toLowerCase();

        if(['create','update','delete'].indexOf(operation) === -1) {
            console.log(`   ⚠️  Invalid operation "${operation}". Skipping.`);
            continue;
        }

        if (operation === 'update' || operation === 'delete') {
            if (!record.data.Id) {
                console.log(`   ⚠️  ${operation.charAt(0).toUpperCase() + operation.slice(1)} operation requires an Id field. Skipping.`);
                continue;
            }
        }

        try {
            let result;
            if (operation === 'create') {
                result = await connection.sobject(record.sObject).create(record.data);
            } else if (operation === 'update') {
                result = await connection.sobject(record.sObject).update(record.data);
            } else {
                result = await connection.sobject(record.sObject).delete(record.data.Id);
            }

            if (result?.success) {
                console.log(`✅ ${operation} successful (ID: ${result.id || record.data.Id})`);
            } else {
                const errors = (result?.errors || []).map(e => e.message || e).join(', ');
                console.log(`❌ Failed: ${errors || 'Unknown error'}`);
            }
        } catch (error) {
            console.log(`❌ Failed: ${error.message}`);
        }

    }
}

main();