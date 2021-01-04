/**
 * Copyright 2021 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const CLOUD_UTIL_NO_RETRY = require('@f5devcentral/f5-cloud-libs').util.NO_RETRY;
const Logger = require('./logger');
const PATHS = require('./sharedConstants').PATHS;
const RADIUS = require('./sharedConstants').RADIUS;
const AUTH = require('./sharedConstants').AUTH;

const logger = new Logger(module);

/**
 * Handles system parts of a declaration.
 *
 * @class
 */
class AuthHandler {
    /**
     * Constructor
     *
     * @param {Object} declaration - Parsed declaration.
     * @param {Object} bigIp - BigIp object.
     * @param {EventEmitter} - DO event emitter.
     * @param {State} - The doState.
     */
    constructor(declaration, bigIp, eventEmitter, state) {
        this.declaration = declaration;
        this.bigIp = bigIp;
        this.eventEmitter = eventEmitter;
        this.state = state;
    }

    /**
     * Starts processing.
     *
     * @returns {Promise} A promise which is resolved when processing is complete
     *                    or rejected if an error occurs.
     */
    process() {
        logger.fine('Processing authentication declaration.');
        const auth = (this.declaration.Common || {}).Authentication;

        if (!auth) {
            return handleRemoteAuthRoles.call(this);
        }

        return handleRemoteAuthRoles.call(this)
            .then(() => handleRadius.call(this))
            .then(() => handleTacacs.call(this))
            .then(() => handleLdap.call(this))
            .then(() => handleSource.call(this))
            .then(() => handleRemoteUsersDefaults.call(this));
    }
}

function handleRemoteAuthRoles() {
    if (!this.declaration.Common || !this.declaration.Common.RemoteAuthRole) {
        return Promise.resolve();
    }
    const promiseChain = Object.keys(this.declaration.Common.RemoteAuthRole).map((name) => {
        const decl = this.declaration.Common.RemoteAuthRole[name];
        const rr = {};
        rr.attribute = decl.attribute;
        rr.console = decl.console;
        // deny is equivalent to denyRemoteAccess, thus remoteAccess === true is equivalent to deny === false
        rr.deny = (decl.remoteAccess) ? 'disabled' : 'enabled';
        rr.lineOrder = decl.lineOrder;
        rr.role = decl.role;
        rr.userPartition = decl.userPartition;
        rr.name = name;
        return this.bigIp.createOrModify(PATHS.AuthRemoteRole, rr);
    });

    return Promise.all(promiseChain);
}


function handleRadius() {
    const radius = this.declaration.Common.Authentication.radius;

    if (!radius || !radius.servers || !radius.servers.primary) {
        return Promise.resolve();
    }
    const serverProms = [];
    const authServers = [RADIUS.PRIMARY_SERVER];

    const primary = radius.servers.primary;
    primary.name = RADIUS.PRIMARY_SERVER;
    primary.partition = 'Common';
    serverProms.push(this.bigIp.createOrModify(PATHS.AuthRadiusServer, primary));

    if (radius.servers.secondary) {
        const secondary = radius.servers.secondary;
        secondary.name = RADIUS.SECONDARY_SERVER;
        secondary.partition = 'Common';
        serverProms.push(this.bigIp.createOrModify(PATHS.AuthRadiusServer, secondary));
        authServers.push(RADIUS.SECONDARY_SERVER);
    }

    const opts = { silent: true };
    return Promise.all(serverProms)
        .then(() => this.bigIp.createOrModify(
            PATHS.AuthRadius,
            {
                name: AUTH.SUBCLASSES_NAME,
                serviceType: radius.serviceType,
                servers: authServers,
                partition: 'Common'
            },
            undefined, undefined, opts
        ))
        .then(() => (radius.servers.secondary ? Promise.resolve() : this.bigIp.delete(
            `${PATHS.AuthRadiusServer}/~Common~${RADIUS.SECONDARY_SERVER}`,
            null, null, CLOUD_UTIL_NO_RETRY
        )))
        .catch((err) => {
            logger.severe(`Error configuring remote RADIUS auth: ${err.message}`);
            return Promise.reject(err);
        });
}

function handleTacacs() {
    const tacacs = this.declaration.Common.Authentication.tacacs;

    if (!tacacs) {
        return Promise.resolve();
    }

    const tacacsObj = {
        name: AUTH.SUBCLASSES_NAME,
        partition: 'Common',
        accounting: tacacs.accounting || 'send-to-first-server',
        authentication: tacacs.authentication || 'use-first-server',
        debug: tacacs.debug ? 'enabled' : 'disabled',
        encryption: tacacs.encryption === false ? 'disabled' : 'enabled',
        secret: tacacs.secret,
        servers: tacacs.servers,
        service: tacacs.service
    };
    if (tacacs.protocol) tacacsObj.protocol = tacacs.protocol;

    return this.bigIp.createOrModify(PATHS.AuthTacacs, tacacsObj)
        .catch((err) => {
            logger.severe(`Error configuring remote TACACS auth: ${err.message}`);
        });
}

function handleLdap() {
    const ldap = this.declaration.Common.Authentication.ldap;

    if (!ldap) {
        return Promise.resolve();
    }

    const getCertPath = certObj => `/${certObj.partition}/${certObj.name}`;
    const certPromises = [];

    const ldapObj = {
        name: AUTH.SUBCLASSES_NAME,
        partition: 'Common',
        bindDn: ldap.bindDn || 'none',
        bindPw: ldap.bindPassword || 'none',
        bindTimeout: ldap.bindTimeout,
        checkHostAttr: ldap.checkBindPassword ? 'enabled' : 'disabled',
        checkRolesGroup: ldap.checkRemoteRole ? 'enabled' : 'disabled',
        filter: ldap.filter || 'none',
        groupDn: ldap.groupDn || 'none',
        groupMemberAttribute: ldap.groupMemberAttribute || 'none',
        idleTimeout: ldap.idleTimeout,
        ignoreAuthInfoUnavail: ldap.ignoreAuthInfoUnavailable ? 'yes' : 'no',
        ignoreUnknownUser: ldap.ignoreUnknownUser ? 'enabled' : 'disabled',
        loginAttribute: ldap.loginAttribute || 'none',
        port: ldap.port,
        scope: ldap.searchScope,
        searchBaseDn: ldap.searchBaseDn || 'none',
        searchTimeout: ldap.searchTimeout,
        servers: ldap.servers,
        ssl: ldap.ssl,
        sslCaCertFile: ldap.sslCaCert ? getCertPath(ldap.sslCaCert) : 'none',
        sslCheckPeer: ldap.sslCheckPeer ? 'enabled' : 'disabled',
        sslCiphers: ldap.sslCiphers ? ldap.sslCiphers.join(':') : '',
        sslClientCert: ldap.sslClientCert ? getCertPath(ldap.sslClientCert) : 'none',
        sslClientKey: ldap.sslClientKey ? getCertPath(ldap.sslClientKey) : 'none',
        userTemplate: ldap.userTemplate || 'none',
        version: ldap.version
    };

    const options = ldapObj.bindPw ? { silent: true } : {};

    if (ldap.sslCaCert && ldap.sslCaCert.base64) {
        certPromises.push(
            handleCert.call(this, 'do_ldapCaCert.crt', ldap.sslCaCert, PATHS.SSLCert)
        );
    }
    if (ldap.sslClientCert && ldap.sslClientCert.base64) {
        certPromises.push(
            handleCert.call(this, 'do_ldapClientCert.crt', ldap.sslClientCert, PATHS.SSLCert)
        );
    }
    if (ldap.sslClientKey && ldap.sslClientKey.base64) {
        certPromises.push(
            handleCert.call(this, 'do_ldapClientCert.key', ldap.sslClientKey, PATHS.SSLKey)
        );
    }

    return Promise.all(certPromises)
        .then(() => this.bigIp.createOrModify(PATHS.AuthLdap, ldapObj, undefined, undefined, options))
        .catch((err) => {
            logger.severe(`Error configuring remote LDAP auth: ${err.message}`);
            return Promise.reject(err);
        });
}

function handleSource() {
    const auth = this.declaration.Common.Authentication;
    let type = auth.enabledSourceType;

    if (type === 'activeDirectory') {
        type = 'active-directory';
    }

    return this.bigIp.modify(
        PATHS.AuthSource,
        {
            type,
            fallback: auth.fallback
        }
    );
}

function handleRemoteUsersDefaults() {
    // shows up as "Other External Users" in Users tab
    const auth = this.declaration.Common.Authentication;
    const authDefaults = auth.remoteUsersDefaults;

    if (!authDefaults) {
        return Promise.resolve();
    }

    return this.bigIp.modify(
        PATHS.AuthRemoteUser,
        {
            defaultPartition: authDefaults.partitionAccess,
            defaultRole: authDefaults.role,
            remoteConsoleAccess: authDefaults.terminalAccess
        }
    );
}

function handleCert(certName, certObj, certPath) {
    const uploadCert = (name, data) => {
        const path = `${PATHS.Uploads}/${name}`;
        const dataStr = Buffer.from(data, 'base64').toString().trim();
        const dataSize = Buffer.byteLength(dataStr);
        const reqOpts = {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': dataSize.toString(),
                'Content-Range': `0-${dataSize - 1}/${dataSize}`
            }
        };
        const opts = {
            silent: path.endsWith('.key')
        };

        return this.bigIp.create(path, dataStr, reqOpts, undefined, opts);
    };

    const createCert = (name, path) => {
        const data = {
            name,
            sourcePath: `file:/var/config/rest/downloads/${name}`
        };
        return this.bigIp.createOrModify(path, data);
    };

    const deleteCert = (name) => {
        const data = {
            command: 'run',
            utilCmdArgs: `/var/config/rest/downloads/${name}`
        };
        return this.bigIp.create(PATHS.UnixRm, data);
    };

    return uploadCert(certName, certObj.base64)
        .then(() => createCert(certName, certPath))
        .then(() => deleteCert(certName));
}

module.exports = AuthHandler;
