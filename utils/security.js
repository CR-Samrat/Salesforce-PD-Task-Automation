function escapeSoqlString(value) {
    if (!value) return value;
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeSoqlArray(values) {
    return values.map(v => escapeSoqlString(v));
}

function isValidSalesforceIdentifier(value) {
    if (!value) return false;
    return /^[a-zA-Z][a-zA-Z0-9_]{0,39}(__c)?$/.test(value);
}

function isValidProfileName(value) {
    if (!value) return false;
    return /^[a-zA-Z0-9\s:_-]{1,255}$/.test(value) && 
           !value.includes("'") && 
           !value.includes('"') &&
           !value.includes('--') &&
           !value.includes('/*');
}

function isValidSalesforceId(value) {
    return /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(value);
}

function containsPathTraversal(value) {
    return value.includes('..') || value.includes('/') || value.includes('\\');
}

const RESTRICTED_SOBJECTS = [
    'User',
    'Profile',
    'PermissionSet',
    'PermissionSetAssignment',
    'Organization',
    'AuthSession',
    'LoginHistory',
    'SetupAuditTrail',
    'AuthProvider',
    'ConnectedApplication',
];

const RESTRICTED_FIELDS = [
    'OwnerId',
    'CreatedById',
    'LastModifiedById',
    'IsDeleted',
    'SystemModstamp',
    'ProfileId',
    'UserRoleId',
    'PermissionSetId',
];

module.exports = {
    escapeSoqlString,
    escapeSoqlArray,
    isValidSalesforceIdentifier,
    isValidProfileName,
    isValidSalesforceId,
    containsPathTraversal,
    RESTRICTED_SOBJECTS,
    RESTRICTED_FIELDS
};