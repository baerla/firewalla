/*    Copyright 2016 - 2020 Firewalla Inc
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const VPNProfileManager = require('../net2/VPNProfileManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient();
const bone = require("../lib/Bone.js");
const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');

const fc = require('../net2/config.js');

const featureName = "adblock";
const policyKeyName = "adblock";
const configKey = "ext.adblock.config";
const configlistKey = "ads.list"
const RELOAD_INTERVAL = 3600 * 24 * 1000;

class AdblockPlugin extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.macAddressSettings = {};
        this.networkSettings = {};
        this.tagSettings = {};
        this.vpnProfileSettings = {};
        this.nextReloadFilter = [];
        this.reloadCount = 0;
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy,
            start: this.start,
            stop: this.stop
        });

        this.hookFeature(featureName);
        sem.on('ADBLOCK_CONFIG_REFRESH', (event) => {
          this.applyAdblock();
        });
    }

    async job() {
        await this.applyAdblock();
    }

    async apiRun() {
      extensionManager.onSet("adblockConfig", async (msg, data) => {
        await rclient.setAsync(configKey, JSON.stringify(data));
        sem.sendEventToFireMain({
          type: 'ADBLOCK_CONFIG_REFRESH'
        });
      });
      extensionManager.onGet("adblockConfig", async (msg, data) => {
        return this.getAdblockConfig();
      });
    }

    async getAdblockConfig() {
      const json = await rclient.getAsync(configKey);
      try {
        if (json == null) {
          const result = {};
          log.info(`Load config list from bone: ${configlistKey}`);
          const data = await bone.hashsetAsync(configlistKey);
          const arr = JSON.parse(data);
          if (Array.isArray(arr)) {
            for (var i=0; i<arr.length; i++) {
              if (arr[i] == "ads") result[arr[i]] = "on";  
              else result[arr[i]] = "off";
            }
          }
          await rclient.setAsync(configKey, JSON.stringify(result));
          return result;
        }
        return JSON.parse(json);
      } catch(err) {
        log.error(`Got error when loading config from ${configKey}`);
        return {};
      }
    }
    async applyPolicy(host, ip, policy) {
      log.info("Applying adblock policy:", ip, policy);
      try {
        if (ip === '0.0.0.0') {
          if (policy === true) {
            this.systemSwitch = true;
            if (fc.isFeatureOn(featureName, true)) {//compatibility: new firewlla, old app
              await fc.enableDynamicFeature(featureName);
              return;
            }
          } else {
            this.systemSwitch = false;
          }
          return this.applySystemAdblock();
        } else {
          if (!host)
            return;
          switch (host.constructor.name) {
            case "Tag": {
              const tagUid = host.o && host.o.uid
              if (tagUid) {
                if (policy === true)
                  this.tagSettings[tagUid] = 1;
                // false means unset, this is for backward compatibility
                if (policy === false)
                  this.tagSettings[tagUid] = 0;
                // null means disabled, this is for backward compatibility
                if (policy === null)
                  this.tagSettings[tagUid] = -1;
                await this.applyTagAdblock(tagUid);
              }
              break;
            }
            case "NetworkProfile": {
              const uuid = host.o && host.o.uuid;
              if (uuid) {
                if (policy === true)
                  this.networkSettings[uuid] = 1;
                if (policy === false)
                  this.networkSettings[uuid] = 0;
                if (policy === null)
                  this.networkSettings[uuid] = -1;
                await this.applyNetworkAdblock(uuid);
              }
              break;
            }
            case "Host": {
              const macAddress = host && host.o && host.o.mac;
              if (macAddress) {
                if (policy === true)
                  this.macAddressSettings[macAddress] = 1;
                if (policy === false)
                  this.macAddressSettings[macAddress] = 0;
                if (policy === null)
                  this.macAddressSettings[macAddress] = -1;
                await this.applyDeviceAdblock(macAddress);
              }
              break;
            }
            case "VPNProfile": {
              const cn = host.o && host.o.cn;
              if (cn) {
                if (policy === true)
                  this.vpnProfileSettings[cn] = 1;
                // false means unset, this is for backward compatibility
                if (policy === false)
                  this.vpnProfileSettings[cn] = 0;
                // null means disabled, this is for backward compatibility
                if (policy === null)
                  this.vpnProfileSettings[cn] = -1;
                await this.applyVPNProfileAdblock(cn);
              }
              break;
            }
            default:
          }
        }
      } catch (err) {
        log.error("Got error when applying adblock policy", err);
      }
    }
    _scheduleNextReload(oldNextState, curNextState) {
      if (oldNextState === curNextState) {
        // no need immediate reload when next state not changed during reloading
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter.length = 0;
        log.info(`schedule next reload for adblock in ${RELOAD_INTERVAL / 1000}s`);
        this.nextReloadFilter.push(setTimeout(this._reloadFilter.bind(this), RELOAD_INTERVAL));
      } else {
        log.warn(`adblock's next state changed from ${oldNextState} to ${curNextState} during reload, will reload again immediately`);
        if (this.reloadFilterImmediate) {
          clearImmediate(this.reloadFilterImmediate)
        }
        this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this));
      }
    }

    async updateFilter() {
      const config = await this.getAdblockConfig();
      await this._updateFilter(config);
    }

    async _updateFilter(config) {
      for (const key in config) {
        const configFilePath = `${dnsmasqConfigFolder}/${key}_adblock.conf`;
        const value = config[key];
        if (value === 'off') {
          try {
            if (fs.existsSync(configFilePath)) {
              await fs.unlinkAsync(configFilePath);
            }
          } catch (err) {
            log.error(`Failed to remove file: '${configFilePath}'`, err);
          }
          continue;
        }
        let data = null;
        try {
          data = await bone.hashsetAsync(key);
        } catch (err) {
          log.error("Error when load adblocks from bone", err);
          continue;
        }
        let arr = null;
        try {
          arr = JSON.parse(data);
        } catch (err) {
          log.error("Error when parse adblocks", err);
          continue;
        }
        try {
          await this.writeToFile(arr, configFilePath + ".tmp");
          await fs.accessAsync(configFilePath + ".tmp", fs.constants.F_OK);
          await fs.renameAsync(configFilePath + ".tmp", configFilePath);
        } catch (err) {
          log.error(`Error when write to file: '${configFilePath}'`, err);
        }
      }
    }

    async writeToFile(hashes, file) {
      return new Promise((resolve, reject) => {
        log.info("Writing hash filter file:", file);
        let writer = fs.createWriteStream(file);
        writer.on('finish', () => {
          log.info("Finished writing hash filter file", file);
          resolve();
        });
        writer.on('error', err => {
          reject(err);
        });
        hashes.forEach((hash) => {
          let line = util.format("hash-address=/%s/%s%s\n", hash.replace(/\//g, '.'), "", "$adblock")
          writer.write(line);
        });
        writer.end();
      });
    }

    async cleanUpFilter() {
      const config = await this.getAdblockConfig();
      for (const key in config) {
        const file = `${dnsmasqConfigFolder}/${key}_adblock.conf`;
        try {
          if (fs.existsSync(file)) {
            await fs.unlinkAsync(file);
          }
        } catch (err) {
          log.error(`Failed to delete file: '${file}'`, err);
        }
      }
    }

    _reloadFilter() {
      let preState = this.state;
      let nextState = this.nextState;
      this.state = nextState;
      log.info(`in reloadFilter(adblock): preState: ${preState}, nextState: ${this.state}, this.reloadCount: ${this.reloadCount++}`);
      if (nextState === true) {
        log.info(`Start to update adblock filters.`);
        this.updateFilter()
        .then(()=> {
          log.info(`Update adblock filters successful.`);
          dnsmasq.scheduleRestartDNSService();
          this._scheduleNextReload(nextState, this.nextState);
        })
        .catch(err=>{
          log.error(`Update adblock filters Failed!`, err);
        })
      } else {
        if (preState === false && nextState === false) {
          // disabled, no need do anything
          this._scheduleNextReload(nextState, this.nextState);
          return;
        }
        log.info(`Start to clean up adblock filters.`);
        this.cleanUpFilter()
          .catch(err => log.error(`Error when clean up adblock filters`, err))
          .then(() => {
            dnsmasq.scheduleRestartDNSService();
            this._scheduleNextReload(nextState, this.nextState);
          });
      }
    }
    controlFilter(state) {
      this.nextState = state;
      log.info(`adblock nextState is: ${this.nextState}`);
      if (this.state !== undefined) {
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter.length = 0;
      }
      if (this.reloadFilterImmediate) {
        clearImmediate(this.reloadFilterImmediate)
      }
      this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this));
    }

    async applyAdblock() {
      this.controlFilter(this.adminSystemSwitch);

      await this.applySystemAdblock();
      for (const macAddress in this.macAddressSettings) {
        await this.applyDeviceAdblock(macAddress);
      }
      for (const tagUid in this.tagSettings) {
        const tag = TagManager.getTagByUid(tagUid);
        if (!tag)
          // reset tag if it is already deleted
          this.tagSettings[tagUid] = 0;
        await this.applyTagAdblock(tagUid);
        if (!tag)
          delete this.tagSettings[tagUid];
      }
      for (const uuid in this.networkSettings) {
        const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        if (!networkProfile)
          delete this.networkSettings[uuid];
        else
          await this.applyNetworkAdblock(uuid);
      }
      for (const cn in this.vpnProfileSettings) {
        const vpnProfile = VPNProfileManager.getVPNProfile(cn);
        if (!vpnProfile)
          delete this.vpnProfileSettings[cn];
        else
          await this.applyVPNProfileAdblock(cn);
      }
    }

    async applySystemAdblock() {
      if(this.systemSwitch) {
        return this.systemStart();
      } else {
        return this.systemStop();
      }
    }
  
    async applyTagAdblock(tagUid) {
      if (this.tagSettings[tagUid] == 1)
        return this.perTagStart(tagUid);
      if (this.tagSettings[tagUid] == -1)
        return this.perTagStop(tagUid);
      return this.perTagReset(tagUid);
    }
  
    async applyNetworkAdblock(uuid) {
      if (this.networkSettings[uuid] == 1)
        return this.perNetworkStart(uuid);
      if (this.networkSettings[uuid] == -1)
        return this.perNetworkStop(uuid);
      return this.perNetworkReset(uuid);
    }
  
    async applyDeviceAdblock(macAddress) {
      if (this.macAddressSettings[macAddress] == 1)
        return this.perDeviceStart(macAddress);
      if (this.macAddressSettings[macAddress] == -1)
        return this.perDeviceStop(macAddress);
      return this.perDeviceReset(macAddress);
    }

    async applyVPNProfileAdblock(cn) {
      if (this.vpnProfileSettings[cn] == 1)
        return this.perVPNProfileStart(cn);
      if (this.vpnProfileSettings[cn] == -1)
        return this.perVPNProfileStop(cn);
      return this.perVPNProfileReset(cn);
    }

    async systemStart() {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async systemStop() {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagStart(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagStop(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagReset(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => {});
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perNetworkStart(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
        if (!iface) {
          log.warn(`Interface name is not found on ${uuid}`);
          return;
        }
        const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
        const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
    }
  
    async perNetworkStop(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
      if (!iface) {
        log.warn(`Interface name is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
      // explicit disable family protect
      const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perNetworkReset(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
      if (!iface) {
        log.warn(`Interface name is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
      // remove config file
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perDeviceStart(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perDeviceStop(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perDeviceReset(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      // remove config file
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
    }

    async perVPNProfileStart(cn) {
      const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${cn}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perVPNProfileStop(cn) {
      const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${cn}$!${featureName}\n`; // match negative tag
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perVPNProfileReset(cn) {
      const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
    }

    // global on/off
    async globalOn() {
        this.adminSystemSwitch = true;
        this.applyAdblock();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        this.applyAdblock();
    }
}

module.exports = AdblockPlugin
