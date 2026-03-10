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
                const fieldPermissionId = fpResult.records[0].Id;
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

async function createCustomRecords(connection, recordsConfig) {
    console.log('\n📝 Creating Custom Records...');

    for (const record of recordsConfig) {
        try {
            console.log(`   - ${record.sObject}: ${record.data.Name || 'Record'}`);

            const result = await connection.sobject(record.sObject).create(record.data);

            if (result.success) {
                console.log(`   ✅ Created successfully (ID: ${result.id})`);
            } else {
                console.log(`   ❌ Failed: ${result.errors.join(', ')}`);
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
}

main();