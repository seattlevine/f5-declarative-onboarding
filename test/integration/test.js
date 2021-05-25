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

/*
   This is a module to be tested, each function being responsible for a set of tests
   such as Onboarding, Networking, licensing, etc. Functions act on a target BIG-IP in which
   the Declarative Onboarding rpm package has already been installed. Each function takes
   the same 3 parameters. Those are the target BIG-IP's ip address, admin username and admin
   password (last two are the username/password used to call the DO API)
 */

'use strict';

const assert = require('assert');
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;
const constants = require('./constants');
const common = require('./common');
const logger = require('./logger').getInstance();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/* eslint-disable no-console */
/* eslint-disable prefer-arrow-callback */


describe('Declarative Onboarding Integration Test Suite', function performIntegrationTest() {
    // location of DO test JSON bodies
    const BODIES = 'test/integration/bodies';
    const machines = [];
    before(function setup() {
        return common.readFile(process.env.TEST_HARNESS_FILE)
            .then(file => JSON.parse(file))
            .then((deployedMachines) => {
                deployedMachines.forEach((deployedMachine) => {
                    machines.push({
                        ip: deployedMachine.admin_ip,
                        adminUsername: deployedMachine.f5_rest_user.username,
                        adminPassword: deployedMachine.f5_rest_user.password
                    });
                });
                return Promise.resolve();
            })
            .then(() => {
                if (!process.env.BIG_IQ_HOST || !process.env.BIG_IQ_USERNAME
                    || !process.env.BIG_IQ_PASSWORD) {
                    return Promise.reject(new Error('At least one of BIG_IQ_HOST, BIG_IQ_USERNAME,'
                        + 'BIG_IQ_PASSWORD not set'));
                }
                return Promise.resolve();
            })
            .catch(error => Promise.reject(error));
    });

    describe('Test Onboard', function testOnboard() {
        this.timeout(1000 * 60 * 30); // 30 minutes
        let body;
        let currentState;

        before(() => {
            const thisMachine = machines[0];
            const bigIpAddress = thisMachine.ip;
            const bodyFile = `${BODIES}/onboard.json`;
            const bigIpAuth = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
            return common.readFile(bodyFile)
                .then(JSON.parse)
                .then((readBody) => {
                    body = readBody;
                })
                .then(() => common.testRequest(
                    body,
                    `${common.hostname(bigIpAddress, constants.PORT)}${constants.DO_API}`, bigIpAuth,
                    constants.HTTP_ACCEPTED, 'POST'
                ))
                .then(() => common.testGetStatus(60, 30 * 1000, bigIpAddress, bigIpAuth,
                    constants.HTTP_SUCCESS))
                .then((response) => {
                    currentState = response.currentConfig.Common;
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        after(() => {
            const thisMachine = machines[0];
            const bigIpAddress = thisMachine.ip;
            const bigIpAuth = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
            return common.testOriginalConfig(bigIpAddress, bigIpAuth)
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        it('should match the hostname', () => {
            assert.ok(testHostname(body.Common, currentState));
        });

        it('should match the DNS', () => {
            assert.ok(testDns(body.Common.myDns, currentState));
        });

        it('should match the NTP', () => {
            assert.ok(testNtp(body.Common.myNtp, currentState));
        });

        it('should match provisioning', () => {
            const provisionModules = ['ltm', 'gtm'];
            assert.ok(testProvisioning(body.Common.myProvisioning, currentState, provisionModules));
        });

        it('should match VLAN', () => {
            assert.ok(testVlan(body.Common.myVlan, currentState));
        });

        it('should match routing', () => {
            assert.ok(testRoute(body.Common.myRoute, currentState, 'myRoute'));
        });

        it('should match failover unicast address', () => assert.deepStrictEqual(
            currentState.FailoverUnicast,
            {
                addressPorts: [
                    {
                        address: '10.148.75.46',
                        port: 1026
                    },
                    {
                        address: '10.148.75.46',
                        port: 126
                    }
                ]
            }
        ));

        it('should match failover multicast', () => assert.deepStrictEqual(
            currentState.FailoverMulticast,
            {
                interface: 'eth0',
                address: '224.0.0.100',
                port: 123
            }
        ));

        it('should match configsync ip address', () => {
            assert.ok(testConfigSyncIp(body.Common, currentState));
        });

        it('should have created the DeviceGroup', () => assert.deepStrictEqual(
            currentState.DeviceGroup.myFailoverGroup,
            {
                name: 'myFailoverGroup',
                asmSync: 'disabled',
                autoSync: 'enabled',
                fullLoadOnSync: 'false',
                networkFailover: 'enabled',
                saveOnAutoSync: 'false',
                type: 'sync-failover'
            }
        ));

        it('should have created the TrafficGroup', () => assert.deepStrictEqual(
            currentState.TrafficGroup.myTrafficGroup,
            {
                name: 'myTrafficGroup',
                autoFailbackEnabled: 'false',
                autoFailbackTime: 50,
                failoverMethod: 'ha-order',
                haLoadFactor: 1,
                haOrder: ['/Common/f5.example.com']
            }
        ));
    });

    describe('Test Networking', function testNetworking() {
        this.timeout(1000 * 60 * 30); // 30 minutes
        let body;
        let currentState;

        before(() => {
            const thisMachine = machines[1];
            const bigIpAddress = thisMachine.ip;
            const bigIpAuth = { username: thisMachine.adminUsername, password: thisMachine.adminPassword };
            const bodyFile = `${BODIES}/network.json`;
            return common.readFile(bodyFile)
                .then((fileRead) => {
                    body = JSON.parse(fileRead);
                })
                .then(() => common.testRequest(body, `${common.hostname(bigIpAddress, constants.PORT)}`
                    + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST'))
                .then(() => common.testGetStatus(60, 30 * 1000, bigIpAddress, bigIpAuth,
                    constants.HTTP_SUCCESS))
                .then((response) => {
                    currentState = response.currentConfig.Common;
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        after(() => {
            const thisMachine = machines[1];
            const bigIpAddress = thisMachine.ip;
            const bigIpAuth = { username: thisMachine.adminUsername, password: thisMachine.adminPassword };
            return common.testOriginalConfig(bigIpAddress, bigIpAuth)
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        it('should match self ip', () => {
            assert.ok(testSelfIp(body.Common.mySelfIp, currentState));
        });

        it('should match VLAN', () => {
            assert.ok(testVlan(body.Common.myVlan, currentState));
        });

        it('should match routing', () => {
            assert.ok(testRoute(body.Common.myRoute, currentState, 'myRoute'));
        });

        it('should match routing that needs created in order', () => {
            assert.ok(testRoute(body.Common.int_rt, currentState, 'int_rt'));
            assert.ok(testRoute(body.Common.int_gw_interface, currentState, 'int_gw_interface'));
        });

        it('should match localOnly routing', () => {
            assert.deepStrictEqual(
                currentState.Route.myLocalOnlyRoute,
                {
                    name: 'myLocalOnlyRoute',
                    mtu: 0,
                    network: 'default',
                    localOnly: true,
                    target: 'myVlan'
                }
            );
        });

        it('should match dns resolver', () => {
            assert.ok(testDnsResolver(body.Common.myResolver, currentState));
        });

        it('should match ip mirroring', () => {
            assert.strictEqual(currentState.MirrorIp.primaryIp, body.Common.myMirror.primaryIp);
            assert.strictEqual(currentState.MirrorIp.secondaryIp, body.Common.myMirror.secondaryIp);
        });

        it('should match RoutingAsPath', () => assert.deepStrictEqual(
            currentState.RoutingAsPath,
            {
                testRoutingAsPath1: {
                    name: 'testRoutingAsPath1',
                    entries: [
                        {
                            name: 10,
                            regex: '^65001 *'
                        }
                    ]
                },
                testRoutingAsPath2: {
                    name: 'testRoutingAsPath2',
                    entries: [
                        {
                            name: 10,
                            regex: '^$'
                        },
                        {
                            name: 20,
                            regex: '^65005$'
                        }
                    ]
                }
            }
        ));

        it('should match RoutingPrefixList', () => assert.deepStrictEqual(
            currentState.RoutingPrefixList,
            {
                testRoutingPrefixList1: {
                    name: 'testRoutingPrefixList1',
                    entries: [
                        {
                            name: 10,
                            action: 'permit',
                            prefix: '1111:2222::/127',
                            prefixLengthRange: 128
                        }
                    ]
                },
                testRoutingPrefixList2: {
                    name: 'testRoutingPrefixList2',
                    entries: [
                        {
                            name: 20,
                            action: 'permit',
                            prefix: '10.3.3.0/24',
                            prefixLengthRange: 32
                        }
                    ]
                }
            }
        ));

        it('should match RouteMap', () => assert.deepStrictEqual(
            currentState.RouteMap,
            {
                testRouteMap: {
                    name: 'testRouteMap',
                    entries: [
                        {
                            name: 33,
                            action: 'permit',
                            match: {
                                asPath: '/Common/testRoutingAsPath1',
                                ipv4: {
                                    address: {
                                        prefixList: '/Common/testRoutingPrefixList2'
                                    },
                                    nextHop: {}
                                },
                                ipv6: {
                                    address: {
                                        prefixList: '/Common/testRoutingPrefixList1'
                                    },
                                    nextHop: {}
                                }
                            }
                        }
                    ]
                }
            }
        ));

        it('should match RoutingBGP', () => assert.deepStrictEqual(
            currentState.RoutingBGP,
            {
                testRoutingBGP: {
                    name: 'testRoutingBGP',
                    addressFamilies: [
                        {
                            internetProtocol: 'ipv4',
                            redistributionList: [
                                {
                                    routingProtocol: 'kernel',
                                    routeMap: '/Common/testRouteMap'
                                }
                            ]
                        },
                        {
                            internetProtocol: 'ipv6'
                        }
                    ],
                    gracefulRestart: {
                        gracefulResetEnabled: true,
                        restartTime: 120,
                        stalePathTime: 0
                    },
                    holdTime: 35,
                    keepAlive: 10,
                    localAS: 50208,
                    neighbors: [
                        {
                            address: '10.1.1.2',
                            peerGroup: 'Neighbor'
                        }
                    ],
                    peerGroups: [
                        {
                            name: 'Neighbor',
                            addressFamilies: [
                                {
                                    internetProtocol: 'ipv4',
                                    routeMap: {
                                        out: '/Common/testRouteMap'
                                    },
                                    softReconfigurationInboundEnabled: true
                                },
                                {
                                    internetProtocol: 'ipv6',
                                    routeMap: {},
                                    softReconfigurationInboundEnabled: false
                                }
                            ],
                            remoteAS: 65020
                        }
                    ],
                    routerId: '10.1.1.1'
                }
            }
        ));
    });

    describe('Test Experimental Status Codes', function testExperimentalStatusCodes() {
        this.timeout(1000 * 60 * 30); // 30 minutes

        function testStatusCode(query, expectedCode) {
            const thisMachine = machines[1];
            const bigIpAddress = thisMachine.ip;
            const auth = { username: thisMachine.adminUsername, password: thisMachine.adminPassword };
            const bodyFile = `${BODIES}/bogus.json`;
            const url = `${common.hostname(bigIpAddress, constants.PORT)}${constants.DO_API}`;

            return common.readFile(bodyFile)
                .then(fileRead => JSON.parse(fileRead))
                .then(body => common.testRequest(body, url, auth, constants.HTTP_ACCEPTED, 'POST'))
                .then(() => common.testGetStatus(60, 30 * 1000, bigIpAddress, auth, expectedCode, query))
                .then((responseBody) => {
                    // on 14+ this will be a string because of the messed up response
                    if (typeof responseBody === 'string') {
                        assert.notStrictEqual(responseBody.indexOf(constants.HTTP_UNPROCESSABLE.toString()), -1);
                    } else {
                        assert.strictEqual(responseBody.code, constants.HTTP_UNPROCESSABLE);
                        assert.strictEqual(responseBody.result.code, constants.HTTP_UNPROCESSABLE);
                        assert.strictEqual(responseBody.status, 'ERROR');
                    }
                })
                .catch((error) => {
                    logger.info(`got error ${error}`);
                    assert.fail(error);
                });
        }

        it('should return 422 without using a query parameter',
            () => testStatusCode({}, constants.HTTP_UNPROCESSABLE));

        it('should return 422 using legacy statusCodes',
            () => testStatusCode({ statusCodes: 'legacy' }, constants.HTTP_UNPROCESSABLE));

        it('should return 200 using experimental statusCodes',
            () => testStatusCode({ statusCodes: 'experimental' }, constants.HTTP_SUCCESS));
    });

    describe('Test Auth Settings', function testAuth() {
        this.timeout(1000 * 60 * 30); // 30 minutes
        let body;
        let currentState;

        before(() => {
            const thisMachine = machines[2];
            const bigIpAddress = thisMachine.ip;
            const bigIpAuth = { username: thisMachine.adminUsername, password: thisMachine.adminPassword };
            const bodyFile = `${BODIES}/auth.json`;
            return common.readFile(bodyFile)
                .then((fileRead) => {
                    body = JSON.parse(fileRead);
                })
                .then(() => common.testRequest(body, `${common.hostname(bigIpAddress, constants.PORT)}`
                    + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST'))
                .then(() => common.testGetStatus(60, 30 * 1000, bigIpAddress, bigIpAuth,
                    constants.HTTP_SUCCESS))
                .then((response) => {
                    currentState = response.currentConfig.Common;
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        after(() => {
            const thisMachine = machines[2];
            const bigIpAddress = thisMachine.ip;
            const bigIpAuth = { username: thisMachine.adminUsername, password: thisMachine.adminPassword };
            return common.testOriginalConfig(bigIpAddress, bigIpAuth)
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        it('should configure main auth settings', () => {
            assert.ok(testMainAuth(body.Common.myAuth, currentState));
        });

        it('should configure remoteUsersDefaults', () => {
            assert.ok(testRemoteUsersDefaults(body.Common.myAuth.remoteUsersDefaults, currentState));
        });

        it('should configure radius', () => {
            assert.ok(testRadiusAuth(body.Common.myAuth.radius, currentState));
        });

        it('should configure ldap', () => {
            assert.ok(testLdapAuth(body.Common.myAuth.ldap, currentState));
        });

        it('should configure tacacs', () => {
            assert.ok(testTacacsAuth(body.Common.myAuth.tacacs, currentState));
        });

        it('should configure remoteAuthRole', () => {
            assert.ok(testRemoteAuthRole(body.Common.remoteAuthRole, currentState));
        });
    });

    describe('Test Licensing and properties requiring a license', function testLicensing() {
        this.timeout(1000 * 60 * 30); // 30 minutes

        const bigIqAuth = {
            username: process.env.BIG_IQ_USERNAME,
            password: process.env.BIG_IQ_PASSWORD
        };
        const bigIqAddress = process.env.BIG_IQ_HOST;
        const bodyFileLicensing = `${BODIES}/licensing_big_iq.json`;

        let thisMachine;
        let bigIpAddress;
        let bigIpAuth;
        let oldAuditLink;
        let newAuditLink;

        before(() => {
            thisMachine = machines[2];
            bigIpAddress = thisMachine.ip;
            bigIpAuth = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
            return common.readFile(bodyFileLicensing)
                .then(JSON.parse)
                .then((body) => {
                    // need to replace credentials and ip address for BIG-IQ in the
                    // declaration by those we got from environment
                    body.Common.myLicense.bigIqHost = bigIqAddress;
                    body.Common.myLicense.bigIqUsername = bigIqAuth.username;
                    body.Common.myLicense.bigIqPassword = bigIqAuth.password;
                    // also update BIG-IP credentials
                    body.Common.myLicense.bigIpUsername = bigIpAuth.username;
                    body.Common.myLicense.bigIpPassword = bigIpAuth.password;
                    return body;
                })
                .then(body => common.testRequest(body, `${common.hostname(bigIpAddress, constants.PORT)}`
                    + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST'))
                .then(() => common.testGetStatus(20, 60 * 1000, bigIpAddress, bigIpAuth,
                    constants.HTTP_SUCCESS))
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        after(() => common.testOriginalConfig(bigIpAddress, bigIpAuth)
            .catch(error => logError(error, bigIpAddress, bigIpAuth)));

        it('should have licensed', () => {
            logTestTitle(this.ctx.test.title);
            return getAuditLink(bigIqAddress, bigIpAddress, bigIqAuth)
                .then((auditLink) => {
                    logger.info(`auditLink: ${auditLink}`);
                    // save the licensing link to compare against later
                    oldAuditLink = auditLink;
                    assert.ok(auditLink);
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        it('should have re-licensed with new pool', () => {
            logTestTitle(this.ctx.test.title);
            const bodyFileRevokingRelicensing = `${BODIES}/revoking_relicensing_big_iq.json`;
            // now revoke and re-license using another license pool
            return common.readFile(bodyFileRevokingRelicensing)
                .then(JSON.parse)
                .then((body) => {
                    body.Common.myLicense.bigIqHost = bigIqAddress;
                    body.Common.myLicense.bigIqUsername = bigIqAuth.username;
                    body.Common.myLicense.bigIqPassword = bigIqAuth.password;
                    body.Common.myLicense.bigIpUsername = bigIpAuth.username;
                    body.Common.myLicense.bigIpPassword = bigIpAuth.password;
                    return body;
                })
                .then(body => common.testRequest(body, `${common.hostname(bigIpAddress, constants.PORT)}`
                    + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST'))
                .then(() => common.testGetStatus(20, 60 * 1000, bigIpAddress,
                    bigIpAuth, constants.HTTP_SUCCESS))
                .then(() => getAuditLink(bigIqAddress, bigIpAddress, bigIqAuth))
                .then((auditLink) => {
                    logger.info(`auditLink: ${auditLink}`);
                    // if the new audit link is equal to the old, it means the old license wasn't
                    // revoked, because an audit link represents a licensed device (see getAuditLink)
                    assert.notStrictEqual(oldAuditLink, auditLink);
                    newAuditLink = auditLink;
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        describe('Test Firewall', function testFirewall() {
            this.timeout(1000 * 60 * 30); // 30 minutes
            let body;
            let currentState;

            before(() => {
                const bodyFile = `${BODIES}/firewall.json`;
                return common.readFile(bodyFile)
                    .then((fileRead) => {
                        body = JSON.parse(fileRead);
                    })
                    .then(() => common.testRequest(body, `${common.hostname(bigIpAddress, constants.PORT)}`
                        + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST'))
                    .then(() => common.testGetStatus(60, 30 * 1000, bigIpAddress, bigIpAuth,
                        constants.HTTP_SUCCESS))
                    .then((response) => {
                        currentState = response.currentConfig.Common;
                    })
                    .catch(error => logError(error, bigIpAddress, bigIpAuth));
            });

            after(() => common.testOriginalConfig(bigIpAddress, bigIpAuth)
                .catch(error => logError(error, bigIpAddress, bigIpAuth)));

            it('should match self ip', () => {
                assert.deepStrictEqual(
                    currentState.SelfIp,
                    {
                        mySelfIp: {
                            name: 'mySelfIp',
                            address: '10.148.75.46/24',
                            vlan: 'myVlan',
                            trafficGroup: 'traffic-group-local-only',
                            allowService: [
                                'tcp:80'
                            ],
                            enforcedFirewallPolicy: 'myFirewallPolicy',
                            stagedFirewallPolicy: 'myFirewallPolicy'
                        }
                    }
                );
            });

            it('should match VLAN', () => {
                assert.ok(testVlan(body.Common.myVlan, currentState));
            });

            it('should match FirewallPortList', () => assert.deepStrictEqual(
                currentState.FirewallPortList,
                {
                    myFirewallPortList: {
                        name: 'myFirewallPortList',
                        remark: 'firewall port list description',
                        ports: ['8080', '8888']
                    }
                }
            ));

            it('should match FirwallAddressList', () => assert.deepStrictEqual(
                currentState.FirewallAddressList,
                {
                    myFirewallAddressList: {
                        name: 'myFirewallAddressList',
                        remark: 'firewall address list description',
                        addresses: ['10.1.0.1', '10.2.0.0/24'],
                        geo: ['US:Washington']
                    }
                }
            ));

            it('should match FirewallPolicy', () => assert.deepStrictEqual(
                currentState.FirewallPolicy,
                {
                    myFirewallPolicy: {
                        name: 'myFirewallPolicy',
                        remark: 'firewall policy description',
                        rules: [
                            {
                                name: 'firewallPolicyRuleOne',
                                remark: 'firewall policy rule description',
                                action: 'reject',
                                protocol: 'tcp',
                                loggingEnabled: true,
                                source: {
                                    vlans: [
                                        '/Common/myVlan'
                                    ],
                                    addressLists: [
                                        '/Common/myFirewallAddressList'
                                    ],
                                    portLists: [
                                        '/Common/myFirewallPortList'
                                    ]
                                },
                                destination: {
                                    addressLists: [
                                        '/Common/myFirewallAddressList'
                                    ],
                                    portLists: [
                                        '/Common/myFirewallPortList'
                                    ]
                                }
                            },
                            {
                                name: 'firewallPolicyRuleTwo',
                                action: 'accept',
                                protocol: 'any',
                                loggingEnabled: false,
                                source: {},
                                destination: {}
                            }
                        ]
                    }
                }
            ));
        });

        describe('Test GSLB', function testGslb() {
            let currentState;
            let body;

            before(() => {
                const bodyFile = `${BODIES}/gslb.json`;
                // send out gslb declaration
                return common.readFile(bodyFile)
                    .then(JSON.parse)
                    .then((readBody) => {
                        body = readBody;
                    })
                    .then(() => common.testRequest(
                        body,
                        `${common.hostname(bigIpAddress, constants.PORT)}${constants.DO_API}`, bigIpAuth,
                        constants.HTTP_ACCEPTED, 'POST'
                    ))
                    .then(() => common.testGetStatus(60, 15 * 1000, bigIpAddress, bigIpAuth,
                        constants.HTTP_SUCCESS))
                    .then((response) => {
                        currentState = response.currentConfig.Common;
                    })
                    .catch(error => logError(error, bigIpAddress, bigIpAuth));
            });

            after(() => common.testOriginalConfig(bigIpAddress, bigIpAuth)
                .catch(error => logError(error, bigIpAddress, bigIpAuth)));

            it('should have updated GSLB global-settings', () => assert.deepStrictEqual(
                currentState.GSLBGlobals,
                {
                    general: {
                        synchronizationEnabled: true,
                        synchronizationGroupName: 'newGroup',
                        synchronizationTimeTolerance: 123,
                        synchronizationTimeout: 12345
                    }
                }
            ));

            it('should have created GSLB data center', () => assert.deepStrictEqual(
                currentState.GSLBDataCenter.myDataCenter,
                {
                    name: 'myDataCenter',
                    enabled: true,
                    contact: 'dataCenterContact',
                    location: 'dataCenterLocation',
                    proberFallback: 'outside-datacenter',
                    proberPreferred: 'inside-datacenter'
                }
            ));

            it('should have created GSLB server', () => assert.deepStrictEqual(
                currentState.GSLBServer.myGSLBServer,
                {
                    name: 'myGSLBServer',
                    remark: 'GSLB server description',
                    devices: [
                        {
                            remark: 'GSLB server device description',
                            address: '10.10.10.10',
                            addressTranslation: '192.0.2.12'
                        }
                    ],
                    dataCenter: 'myDataCenter',
                    serverType: 'bigip',
                    enabled: false,
                    proberPreferred: 'pool',
                    proberFallback: 'any-available',
                    proberPool: 'myGSLBProberPool',
                    bpsLimit: 10,
                    bpsLimitEnabled: true,
                    ppsLimit: 10,
                    ppsLimitEnabled: true,
                    connectionsLimit: 10,
                    connectionsLimitEnabled: true,
                    serviceCheckProbeEnabled: false,
                    pathProbeEnabled: false,
                    snmpProbeEnabled: false,
                    virtualServerDiscoveryMode: 'enabled',
                    exposeRouteDomainsEnabled: true,
                    cpuUsageLimit: 10,
                    cpuUsageLimitEnabled: true,
                    memoryLimit: 10,
                    memoryLimitEnabled: true,
                    monitors: [
                        '/Common/http',
                        '/Common/myGSLBMonitorHTTP',
                        '/Common/myGSLBMonitorHTTPS',
                        '/Common/myGSLBMonitorICMP',
                        '/Common/myGSLBMonitorTCP',
                        '/Common/myGSLBMonitorUDP'
                    ],
                    virtualServers: [
                        {
                            name: '0',
                            address: '10.0.20.1',
                            port: 80,
                            enabled: true,
                            addressTranslationPort: 0,
                            monitors: []
                        },
                        {
                            name: 'virtualServer',
                            remark: 'GSLB server virtual server description',
                            enabled: false,
                            address: 'a989:1c34:9c::b099:c1c7:8bfe',
                            port: 8080,
                            addressTranslation: '1:0:1::',
                            addressTranslationPort: 80,
                            monitors: [
                                '/Common/tcp',
                                '/Common/http'
                            ]
                        }
                    ]
                }
            ));

            it('should have created GSLB prober pool', () => assert.deepStrictEqual(
                currentState.GSLBProberPool.myGSLBProberPool,
                {
                    name: 'myGSLBProberPool',
                    remark: 'GSLB prober pool description',
                    lbMode: 'round-robin',
                    enabled: false,
                    members: [
                        {
                            order: 0,
                            server: 'myGSLBServer',
                            remark: 'GSLB prober pool member description',
                            enabled: false
                        }
                    ]
                }
            ));

            it('should have created a GSLB monitor of type http', () => assert.deepStrictEqual(
                currentState.GSLBMonitor.myGSLBMonitorHTTP,
                {
                    name: 'myGSLBMonitorHTTP',
                    interval: 100,
                    probeTimeout: 110,
                    send: 'HEAD / HTTP/1.0\\r\\n',
                    timeout: 1000,
                    transparent: true,
                    monitorType: 'http',
                    remark: 'description',
                    target: '1.1.1.1:80',
                    ignoreDownResponseEnabled: true,
                    reverseEnabled: true,
                    receive: 'HTTP'
                }
            ));

            it('should have created a GSLB monitor of type https', () => assert.deepStrictEqual(
                currentState.GSLBMonitor.myGSLBMonitorHTTPS,
                {
                    name: 'myGSLBMonitorHTTPS',
                    interval: 100,
                    probeTimeout: 110,
                    send: 'HEAD / HTTP/1.0\\r\\n',
                    timeout: 1000,
                    transparent: true,
                    monitorType: 'https',
                    remark: 'description',
                    target: '2.2.2.2:80',
                    ignoreDownResponseEnabled: true,
                    reverseEnabled: true,
                    receive: 'HTTP',
                    ciphers: 'DEFAULT',
                    clientCertificate: 'default.crt'
                }
            ));

            it('should have created a GSLB monitor of type gateway-icmp', () => assert.deepStrictEqual(
                currentState.GSLBMonitor.myGSLBMonitorICMP,
                {
                    name: 'myGSLBMonitorICMP',
                    interval: 100,
                    probeTimeout: 110,
                    timeout: 1000,
                    transparent: true,
                    monitorType: 'gateway-icmp',
                    remark: 'description',
                    target: '3.3.3.3:80',
                    ignoreDownResponseEnabled: true,
                    probeInterval: 1,
                    probeAttempts: 3
                }
            ));

            it('should have created a GSLB monitor of type tcp', () => assert.deepStrictEqual(
                currentState.GSLBMonitor.myGSLBMonitorTCP,
                {
                    name: 'myGSLBMonitorTCP',
                    interval: 100,
                    probeTimeout: 110,
                    timeout: 1000,
                    transparent: true,
                    monitorType: 'tcp',
                    remark: 'description',
                    target: '4.4.4.4:80',
                    ignoreDownResponseEnabled: true,
                    reverseEnabled: true,
                    receive: 'example receive',
                    send: 'example send'
                }
            ));

            it('should have created a GSLB monitor of type udp', () => assert.deepStrictEqual(
                currentState.GSLBMonitor.myGSLBMonitorUDP,
                {
                    name: 'myGSLBMonitorUDP',
                    interval: 100,
                    probeTimeout: 110,
                    send: 'default send string',
                    timeout: 1000,
                    transparent: true,
                    monitorType: 'udp',
                    remark: 'description',
                    target: '5.5.5.5:80',
                    ignoreDownResponseEnabled: true,
                    reverseEnabled: true,
                    receive: 'udp receive',
                    debugEnabled: true,
                    probeInterval: 1,
                    probeAttempts: 3
                }
            ));
        });

        describe('further license testing', () => {
            it('should have revoked old license', () => {
                logTestTitle(this.ctx.test.title);
                const retryOptions = {
                    trials: 100,
                    timeInterval: 1000
                };
                return new Promise((resolve, reject) => getF5Token(bigIqAddress, bigIqAuth)
                    .then((token) => {
                        logger.debug(`oldAuditLink: ${oldAuditLink}`);
                        logger.debug(`token: ${token}`);
                        const options = common.buildBody(oldAuditLink, null, { token }, 'GET');
                        return common.sendRequest(options, retryOptions);
                    })
                    .then((response) => {
                        if (response.response.statusCode !== constants.HTTP_SUCCESS) {
                            reject(new Error('could not check revoking'));
                        }
                        return response.body;
                    })
                    .then(JSON.parse)
                    .then((assignment) => {
                        assert.strictEqual(assignment.status, 'REVOKED');
                    })
                    .then(() => {
                        resolve();
                    })
                    .catch(error => logError(error, bigIpAddress, bigIpAuth))
                    .catch((err) => {
                        reject(err);
                    }));
            });

            it('cleanup by revoking new license', () => new Promise((resolve, reject) => {
                logTestTitle(this.ctx.test.title);
                let body;
                const bodyFileRevoking = `${BODIES}/revoke_from_bigiq.json`;
                const retryOptions = {
                    trials: 100,
                    timeInterval: 1000
                };
                return common.readFile(bodyFileRevoking)
                    .then(JSON.parse)
                    .then((bodyStub) => {
                        body = bodyStub;
                        body.address = bigIpAddress;
                        body.user = bigIpAuth.username;
                        body.password = bigIpAuth.password;
                    })
                    .then(() => getF5Token(bigIqAddress, bigIqAuth))
                    .then((token) => {
                        const options = common.buildBody(
                            `${common.hostname(bigIqAddress, constants.PORT)}`
                            + `${constants.ICONTROL_API}/cm/device/tasks/licensing/pool/member-management`,
                            body, { token }, 'POST'
                        );
                        return common.sendRequest(options, retryOptions);
                    })
                    .then((response) => {
                        if (response.response.statusCode !== constants.HTTP_ACCEPTED) {
                            reject(new Error('could not request to revoke license'));
                        }
                        return response.body;
                    })
                    .then(JSON.parse)
                    .then((response) => {
                        logger.info(`Expecting STARTED. Got ${response.status}`);
                        assert.strictEqual(response.status, 'STARTED');
                    })
                    .then(() => {
                        const func = function () {
                            logger.debug('In retry func');
                            return new Promise((resolveThis, rejectThis) => getF5Token(bigIqAddress, bigIqAuth)
                                .then((token) => {
                                    const options = common.buildBody(newAuditLink, null,
                                        { token }, 'GET');
                                    return common.sendRequest(options, retryOptions);
                                })
                                .then((response) => {
                                    logger.debug(`Audit status code ${response.response.statusCode}`);
                                    if (response.response.statusCode === constants.HTTP_SUCCESS) {
                                        logger.debug('Got success status for GET request');
                                        logger.debug(`Looking for REVOKED. Got ${JSON.parse(response.body).status}`);
                                        if (JSON.parse(response.body).status === 'REVOKED') {
                                            logger.debug('resolving retry func');
                                            resolveThis();
                                        } else {
                                            logger.debug('rejecting retry func for status');
                                            rejectThis(new Error(JSON.parse(response.body).status));
                                        }
                                    } else {
                                        logger.debug('rejecting retry func for status code');
                                        rejectThis(new Error(response.response.statusCode));
                                    }
                                })
                                .catch((err) => {
                                    logger.debug(`Retry func caught ${err.message}`);
                                    rejectThis(new Error(err));
                                }));
                        };
                        return common.tryOften(func, 10, 30 * 1000, [constants.HTTP_ACCEPTED, 'GRANTED'], true);
                    })
                    .then(() => {
                        resolve();
                    })
                    .catch(error => logError(error, bigIpAddress, bigIpAuth))
                    .catch((err) => {
                        reject(err);
                    });
            }));
        });
    });

    describe('Test Rollbacking', function testRollbacking() {
        this.timeout(1000 * 60 * 30); // 30 minutes
        let body;
        let currentState;

        before(() => {
            const thisMachine = machines[0];
            const bigIpAddress = thisMachine.ip;
            const bodyFile = `${BODIES}/bogus.json`;
            const bigIpAuth = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
            const query = { statusCodes: 'experimental' };

            // get current configuration to compare against later
            return common.testGetStatus(1, 1, bigIpAddress, bigIpAuth, constants.HTTP_SUCCESS)
                .then((response) => {
                    body = response.currentConfig.Common;
                })
                // send out request with invalid config declaration
                .then(() => common.readFile(bodyFile))
                .then((fileRead) => {
                    const bodyRequest = JSON.parse(fileRead);
                    return common.testRequest(bodyRequest,
                        `${common.hostname(bigIpAddress, constants.PORT)}`
                        + `${constants.DO_API}`, bigIpAuth, constants.HTTP_ACCEPTED, 'POST');
                })
                .then(() => common.testGetStatus(3, 60 * 1000, bigIpAddress, bigIpAuth,
                    constants.HTTP_SUCCESS, query))
                .then((response) => {
                    currentState = response.currentConfig.Common;
                })
                .catch(error => logError(error, bigIpAddress, bigIpAuth));
        });

        it('should have rollback status', () => {
            logTestTitle(this.ctx.test.title);
            // this is a bit weird, because testGetStatus will resolve if the status we passed in
            // is the one found after the request. Since we asked for HTTP_UNPROCESSABLE, it will actually
            // resolve if the configuration was indeed rollbacked. At this point then, since before has
            // resolved, we can just assert the response
            assert.ok(currentState);
        });

        it('should match VLAN', () => {
            logTestTitle(this.ctx.test.title);
            assert.ok(testVlan(body.VLAN.myVlan, currentState));
        });

        it('should match routing', () => {
            logTestTitle(this.ctx.test.title);
            assert.deepStrictEqual(body.Route.myRoute, currentState.Route.myRoute);
        });
    });

    describe('Test Inspect Endpoint', function testAuth() {
        this.timeout(1000 * 60 * 30); // 30 minutes
        const inspectEndpoint = `${constants.DO_API}/inspect`;

        let thisMachine;
        let authData;

        before(() => {
            thisMachine = machines[1];
            authData = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
        });

        /**
         * REST API returns every time different encrypted string for the same secret value.
         * Better to remove secrets from declaration.
         * Ideally it would be better to decrypt every secret which starts with $M.
         */
        const removeSecrets = (declaration) => {
            const currentAuth = declaration.declaration.Common.currentAuthentication;
            if (typeof currentAuth !== 'undefined') {
                if (typeof currentAuth.ldap !== 'undefined') {
                    currentAuth.ldap.bindPassword = '';
                }
                if (typeof currentAuth.radius !== 'undefined'
                    && typeof currentAuth.radius.servers !== 'undefined') {
                    const radiusServers = currentAuth.radius.servers;
                    Object.keys(radiusServers).forEach((rsName) => {
                        radiusServers[rsName].secret = '';
                    });
                }
            }
        };

        it('should get declaration with current device\'s configuration', () => {
            logTestTitle(this.ctx.test.title);
            return common.testRequest(
                null, `${common.hostname(thisMachine.ip, constants.PORT)}${inspectEndpoint}`,
                authData, constants.HTTP_SUCCESS, 'GET'
            )
                .then(JSON.parse)
                .then((body) => {
                    assert.notStrictEqual(body[0].declaration, undefined, 'Should have "declaration" property');
                });
        });

        it('should post declaration with current device\'s configuration', () => {
            logTestTitle(this.ctx.test.title);

            let originDeclaration;

            return common.testRequest(
                null, `${common.hostname(thisMachine.ip, constants.PORT)}${inspectEndpoint}`,
                authData, constants.HTTP_SUCCESS, 'GET'
            )
                .then(JSON.parse)
                .then((body) => {
                    originDeclaration = body[0].declaration;
                    assert.notStrictEqual(originDeclaration, undefined, 'Should have "declaration" property');
                    // apply declaration
                    return common.testRequest(
                        originDeclaration, `${common.hostname(thisMachine.ip, constants.PORT)}${inspectEndpoint}`,
                        authData, constants.HTTP_SUCCESS, 'POST'
                    );
                })
                // fetch declaration again
                .then(() => common.testRequest(
                    null, `${common.hostname(thisMachine.ip, constants.PORT)}${inspectEndpoint}`,
                    authData, constants.HTTP_SUCCESS, 'GET'
                ))
                .then(JSON.parse)
                .then((body) => {
                    // declaration should be the same
                    const declaration = body[0].declaration;
                    removeSecrets(declaration);
                    removeSecrets(originDeclaration);
                    assert.deepStrictEqual(declaration, originDeclaration, 'Should match original declaration');
                });
        });
    });

    describe('Test Example Endpoint', () => {
        const exampleEndpoint = `${constants.DO_API}/example`;
        let thisMachine;
        let authData;

        before(() => {
            thisMachine = machines[0];
            authData = {
                username: thisMachine.adminUsername,
                password: thisMachine.adminPassword
            };
        });

        it('should retrieve an example', () => {
            logTestTitle(this.ctx.test.title);

            return common.testRequest(
                null,
                `${common.hostname(thisMachine.ip, constants.PORT)}${exampleEndpoint}`,
                authData,
                constants.HTTP_SUCCESS,
                'GET',
                1
            )
                .then(JSON.parse)
                .then((body) => {
                    logger.debug(`Got example ${JSON.stringify(body)}`);
                    assert.notStrictEqual(body.Common, undefined);
                });
        });
    });
});

function logTestTitle(testTitle) {
    logger.info(`Starting test: ${testTitle}`);
}

function logError(error, bigIpAddress, bigIpAuth) {
    console.log(error);
    logger.info(error);
    return common.dumpDeclaration(bigIpAddress, bigIpAuth)
        .then(declarationStatus => Promise.reject(new Error(JSON.stringify(declarationStatus, null, 2))));
}

/**
 * getF5Token - returns a new Promise which resolves with a new authorization token for
 *              iControl calls, or reject with error
 * @deviceIp {String} : ip address of target device
 * @auth {Object} : authorization body to retrieve token (username/password)
*/
function getF5Token(deviceIp, auth) {
    return new Promise((resolve, reject) => {
        const options = common.buildBody(`${common.hostname(deviceIp, constants.PORT)}`
            + `${constants.ICONTROL_API}/shared/authn/login`, auth, auth, 'POST');
        const retryOptions = {
            trials: 100,
            timeInterval: 1000
        };
        return common.sendRequest(options, retryOptions)
            .then((response) => {
                if (response.response.statusCode !== constants.HTTP_SUCCESS) {
                    reject(new Error('could not get token'));
                }
                return response.body;
            })
            .then(JSON.parse)
            .then((response) => {
                resolve(response.token.token);
            })
            .catch((error) => {
                reject(error);
            });
    });
}

/**
 * getAuditLink - returns a Promise which resolves with link for later query of licensing information,
 *                or rejects if no licensing information was found for that device, or if the device
 *                is not licensed
 * @bigIqAddress {String} : ip address of BIG-IQ license manager
 * @bigIpAddress {String} : ip address of target licensed BIG-IP
 * @auth {Object} : authorization body for BIG-IQ (username/password)
*/
function getAuditLink(bigIqAddress, bigIpAddress, bigIqAuth) {
    return getF5Token(bigIqAddress, bigIqAuth)
        .then((token) => {
            const func = function () {
                const options = common.buildBody(
                    `${common.hostname(bigIqAddress, constants.PORT)}`
                    + `${constants.ICONTROL_API}/cm/device/licensing/assignments`,
                    null,
                    { token },
                    'GET'
                );
                const retryOptions = {
                    trials: 10,
                    timeInterval: 1000
                };
                return common.sendRequest(options, retryOptions)
                    .then((response) => {
                        logger.info(`get assignments response ${JSON.stringify(response)}`);
                        if (response.response.statusCode !== constants.HTTP_SUCCESS) {
                            return Promise.reject(new Error('could not license'));
                        }
                        return response.body;
                    })
                    .then(response => JSON.parse(response))
                    .then(response => response.items)
                    .then((assignments) => {
                        logger.debug(`current assignments: ${JSON.stringify(
                            assignments.map(
                                assignment => ({
                                    deviceAddress: assignment.deviceAddress,
                                    status: assignment.status,
                                    id: assignment.id
                                })
                            ),
                            null,
                            4
                        )}`);
                        const bigIpAssignments = assignments.filter(current => current.deviceAddress === bigIpAddress);
                        if (bigIpAssignments.length > 0) {
                            const assignment = bigIpAssignments.find(current => current.status === 'LICENSED');
                            if (assignment) {
                                const auditLink = assignment.auditRecordReference.link;
                                // audit links come with the ip address as localhost, we need to
                                // replace it with the address of the BIG-IQ, in order to use it later
                                // to check licensing of a particular device
                                const auditLinkRemote = auditLink.replace(/localhost/gi, bigIqAddress);
                                return auditLinkRemote;
                            }
                            return Promise.reject(new Error(`device license status : ${bigIpAssignments[0].status}`));
                        }
                        return Promise.reject(new Error('no license match for device address'));
                    });
            };
            return common.tryOften(func, 5, 30 * 1000);
        });
}

/**
 * testProvisioning - test a provisioning configuration patter from an
 *                    iControl call against a target object schemed on a
 *                    declaration
 * @target {Object}: object to be tested against
 * @response {Object} : object from status response to compare with target
 * @provisionModules {Array} : list of modules to be tested
 * Returns Promise true/false
 *
*/
function testProvisioning(target, response, provisionModules) {
    return compareSimple(target, response.Provision, provisionModules);
}

/**
 * testSelfIp - test a selfIp configuration pattern from a DO status call
 *              against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testSelfIp(target, response) {
    return compareSimple(target, response.SelfIp.mySelfIp, ['address', 'allowService']);
}

/**
 * testHostname - test a hostname configuration pattern from a DO status call
 *                against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testHostname(target, response) {
    return compareSimple(target, response.System, ['hostname']);
}

/**
 * testDns - test a dns configuration pattern from a DO status call
 *           against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testDns(target, response) {
    return compareSimple(target, response.DNS, ['search', 'nameServers']);
}

/**
 * testNtp - test a ntp configuration pattern from a DO status call
 *           against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testNtp(target, response) {
    return compareSimple(target, response.NTP, ['servers', 'timezone']);
}

/**
 * testVlan - test a vlan configuration pattern from a DO status call
 *            against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testVlan(target, response) {
    return compareSimple(target, response.VLAN.myVlan, ['tag', 'mtu', 'interfaces']);
}

/**
 * testRoute - test a route configuration pattern from a DO status call
 *             against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * @targetName {string} : name of the route to get in response
 * Returns Promise true/false
*/
function testRoute(target, response, targetName) {
    return compareSimple(target, response.Route[targetName], ['gw', 'network', 'mtu']);
}

/**
 * testDnsResolver - test a DNS resolver configuration pattern from a DO status call
 *                   against a target object schemed on a declaration
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * Returns Promise true/false
*/
function testDnsResolver(target, response) {
    const validName = target.forwardZones[0].name === 'forward.net';
    const validNameserver = target.forwardZones[0].nameservers[0] === '10.10.10.10:53';
    return validName && validNameserver && compareSimple(target, response.DNS_Resolver.myResolver, ['routeDomain']);
}

function testConfigSyncIp(target, response) {
    const validRef = target.myConfigSync.configsyncIp === '/Common/mySelfIp/address';
    const validAddr = target.mySelfIp.address.indexOf(response.ConfigSync.configsyncIp) === 0;
    return validRef && validAddr;
}

function testMainAuth(target, response) {
    return compareSimple(target, response.Authentication, ['enabledSourceType', 'fallback']);
}

function testRemoteUsersDefaults(target, response) {
    const remoteResp = response.Authentication.remoteUsersDefaults;
    return compareSimple(target, remoteResp, ['partitionAccess', 'terminalAccess', 'role']);
}

function testRadiusAuth(target, response) {
    const radiusResp = response.Authentication.radius;
    const serviceTypeCheck = compareSimple(target, radiusResp, ['serviceType']);
    const serverPrimaryCheck = compareSimple(
        target.servers.primary,
        radiusResp.servers.primary,
        ['server', 'port']
    );
    const serverSecondaryCheck = compareSimple(
        target.servers.secondary,
        radiusResp.servers.secondary,
        ['server', 'port']
    );
    return serviceTypeCheck && serverPrimaryCheck && serverSecondaryCheck;
}

function testLdapAuth(target, response) {
    const ldapResp = response.Authentication.ldap;
    const strings = [
        'bindDn', 'bindTimeout', 'checkBindPassword', 'checkRemoteRole', 'filter', 'groupDn',
        'groupMemberAttribute', 'idleTimeout', 'ignoreAuthInfoUnavailable',
        'ignoreUnknownUser', 'loginAttribute', 'port', 'searchScope', 'searchBaseDn',
        'searchTimeout', 'servers', 'ssl', 'sslCheckPeer', 'sslCiphers', 'userTemplate', 'version'
    ];
    const currentBigIpVersion = process.env.BIGIP_IMAGE.split('-')[1];
    if (cloudUtil.versionCompare('15.1', currentBigIpVersion) <= 0) {
        strings.push('referrals');
    }
    return compareSimple(
        target,
        ldapResp,
        strings
    );
}

function testTacacsAuth(target, response) {
    const tacacsResp = response.Authentication.tacacs;
    return compareSimple(
        target,
        tacacsResp,
        [
            'accounting', 'authentication', 'debug', 'encryption', 'protocol',
            'servers', 'service'
        ]
    );
}

function testRemoteAuthRole(target, response) {
    const remoteAuthRoleResp = response.RemoteAuthRole.remoteAuthRole;
    return compareSimple(
        target,
        remoteAuthRoleResp,
        [
            'attribute', 'console', 'lineOrder', 'remoteAccess', 'role', 'userPartition'
        ]
    );
}

/**
 * compareSimple - builds a boolean test based on an array of Strings to
 *                 be pairwise-compared among two objects; one coming
 *                 from a status call response, and the other from
 *                 a declaration json schema
 * @target {Object} : object to be tested against
 * @response {Object} : object from status response to compare with target
 * @strings {Array} : list of key strings to be compared on both status call response and target
 * Returns true/false
*/
function compareSimple(target, response, strings) {
    return strings.every(str => compareObjects(str, str, target, response));
}

/**
 * compareObjects - compares value of source accessed with key
 *                  with value of target accessed with key2
 * @key {String} : key of value on source
 * @key2 {String} : key on value on target
 * source {Object} : first object to be compared
 * target {Object} : second object to be compared
 * Returns true/false
*/
function compareObjects(key, key2, source, target) {
    if (JSON.stringify(source[key]) !== JSON.stringify(target[key2])) {
        return false;
    }
    return true;
}
