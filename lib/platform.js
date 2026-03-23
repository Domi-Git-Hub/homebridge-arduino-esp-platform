'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'homebridge-arduino-esp-platform';
const PLATFORM_NAME = 'Arduino_ESP_Platform';

const SERVICE_NAME_MAP = {
  AIR_PURIFIER: 'AirPurifier',
  AIR_QUALITY_SENSOR: 'AirQualitySensor',
  BATTERY: 'Battery',
  CARBON_DIOXIDE_SENSOR: 'CarbonDioxideSensor',
  CARBON_MONOXIDE_SENSOR: 'CarbonMonoxideSensor',
  CONTACT_SENSOR: 'ContactSensor',
  DOOR: 'Door',
  FANV2: 'Fanv2',
  FAUCET: 'Faucet',
  FILTER_MAINTENANCE: 'FilterMaintenance',
  GARAGE_DOOR_OPENER: 'GarageDoorOpener',
  HEATER_COOLER: 'HeaterCooler',
  HUMIDIFIER_DEHUMIDIFIER: 'HumidifierDehumidifier',
  HUMIDITY_SENSOR: 'HumiditySensor',
  IRRIGATION_SYSTEM: 'IrrigationSystem',
  LEAK_SENSOR: 'LeakSensor',
  LIGHTBULB: 'Lightbulb',
  LIGHT_SENSOR: 'LightSensor',
  LOCK_MECHANISM: 'LockMechanism',
  MOTION_SENSOR: 'MotionSensor',
  OCCUPANCY_SENSOR: 'OccupancySensor',
  OUTLET: 'Outlet',
  SECURITY_SYSTEM: 'SecuritySystem',
  SMOKE_SENSOR: 'SmokeSensor',
  SWITCH: 'Switch',
  TEMPERATURE_SENSOR: 'TemperatureSensor',
  THERMOSTAT: 'Thermostat',
  VALVE: 'Valve',
  WINDOW: 'Window',
  WINDOW_COVERING: 'WindowCovering',
};

class ArduinoEspPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;

    this.cachedAccessories = [];
    this.bindings = new Map();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.schemaMeta = loadSchemaMeta(path.join(__dirname, '..', 'config.schema.json'));

    this.api.on('didFinishLaunching', async () => {
      try {
        await this.refreshFromConfig();
        this.startPolling();
      } catch (error) {
        this.log.error(`[${PLATFORM_NAME}] Startup failed: ${error.message}`);
        this.log.debug(error.stack);
      }
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.push(accessory);
  }

  async refreshFromConfig() {
    const desiredSpecs = this.collectDesiredAccessorySpecs();
    const cachedByUUID = new Map(this.cachedAccessories.map((accessory) => [accessory.UUID, accessory]));
    const desiredUUIDs = new Set();
    const nextCachedAccessories = [];
    const accessoriesToRegister = [];

    this.bindings.clear();

    for (const spec of desiredSpecs) {
      desiredUUIDs.add(spec.uuid);

      let accessory = cachedByUUID.get(spec.uuid);
      let isNewAccessory = false;

      if (!accessory) {
        accessory = new this.api.platformAccessory(spec.displayName, spec.uuid);
        isNewAccessory = true;
      }

      accessory.displayName = spec.displayName;
      accessory.context = {
        version: 1,
        kind: spec.kind,
        typeOf: spec.typeOf,
        token: spec.token,
        deviceId: spec.deviceId,
        vpin: spec.vpin,
        name: spec.displayName,
      };

      await this.configureConfiguredAccessory(accessory, spec, isNewAccessory);

      nextCachedAccessories.push(accessory);
      if (isNewAccessory) {
        accessoriesToRegister.push(accessory);
      }
    }

    const accessoriesToUnregister = this.cachedAccessories.filter((accessory) => !desiredUUIDs.has(accessory.UUID));

    if (accessoriesToRegister.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRegister);
      this.log.info(`[${PLATFORM_NAME}] Registered ${accessoriesToRegister.length} accessory(s).`);
    }

    if (accessoriesToUnregister.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToUnregister);
      this.log.info(`[${PLATFORM_NAME}] Unregistered ${accessoriesToUnregister.length} accessory(s).`);
    }

    this.cachedAccessories = nextCachedAccessories;
    this.log.info(`[${PLATFORM_NAME}] Active accessory count: ${this.cachedAccessories.length}.`);
  }

  async configureConfiguredAccessory(accessory, spec, isNewAccessory) {
    this.configureAccessoryInformation(accessory, spec);

    const primaryResult = this.ensureService(accessory, spec.typeOf, spec.displayName, spec.primarySubtype);
    const primaryService = primaryResult.service;
    primaryService.setPrimaryService(true);

    const allowedServiceKeys = new Set();
    allowedServiceKeys.add(this.serviceKey(primaryService));

    const primaryBinding = this.bindService({
      accessory,
      service: primaryService,
      spec: {
        ...spec,
        optionalKeys: spec.optionalKeys,
        forceOptionalKeys: spec.forceOptionalKeys || [],
        nameLocked: true,
      },
    });

    if (spec.typeOf === 'IRRIGATION_SYSTEM') {
      for (const valveSpec of spec.valves) {
        const valveResult = this.ensureService(accessory, 'VALVE', valveSpec.displayName, valveSpec.subtype);
        const valveService = valveResult.service;
        allowedServiceKeys.add(this.serviceKey(valveService));

        this.bindService({
          accessory,
          service: valveService,
          spec: {
            ...valveSpec,
            typeOf: 'VALVE',
            forceOptionalKeys: valveSpec.forceOptionalKeys,
            nameLocked: true,
            isNewService: valveResult.isNew,
          },
        });

        if (typeof primaryService.addLinkedService === 'function') {
          try {
            primaryService.addLinkedService(valveService);
          } catch (error) {
            this.logDebug(`Linked service already exists for ${valveSpec.displayName}: ${error.message}`);
          }
        }
      }
    }

    this.cleanupAccessoryServices(accessory, allowedServiceKeys);

    if (isNewAccessory || primaryBinding.initializationRequired) {
      await this.initializeBinding(primaryBinding);
    }

    if (spec.typeOf === 'IRRIGATION_SYSTEM') {
      for (const valveSpec of spec.valves) {
        const binding = this.bindings.get(valveSpec.bindingId);
        if (binding && (isNewAccessory || binding.initializationRequired)) {
          await this.initializeBinding(binding);
        }
      }
    }
  }

  configureAccessoryInformation(accessory, spec) {
    const information = accessory.getService(this.Service.AccessoryInformation)
      || accessory.addService(this.Service.AccessoryInformation);

    information
      .setCharacteristic(this.Characteristic.Manufacturer, spec.manufacturer)
      .setCharacteristic(this.Characteristic.Model, spec.model)
      .setCharacteristic(this.Characteristic.SerialNumber, spec.serialNumber)
      .setCharacteristic(this.Characteristic.Name, spec.displayName);
  }

  ensureService(accessory, typeOf, displayName, subtype) {
    const ServiceClass = this.getServiceClass(typeOf);
    let service = subtype
      ? accessory.getServiceById(ServiceClass, subtype)
      : accessory.getService(ServiceClass);
    let isNew = false;

    if (!service) {
      service = accessory.addService(ServiceClass, displayName, subtype);
      isNew = true;
    }

    service.displayName = displayName;
    if (service.testCharacteristic(this.Characteristic.Name)) {
      service.updateCharacteristic(this.Characteristic.Name, displayName);
    }

    return { service, isNew };
  }

  cleanupAccessoryServices(accessory, allowedServiceKeys) {
    for (const service of [...accessory.services]) {
      if (service.UUID === this.Service.AccessoryInformation.UUID) {
        continue;
      }

      if (!allowedServiceKeys.has(this.serviceKey(service))) {
        accessory.removeService(service);
      }
    }
  }

  bindService({ accessory, service, spec }) {
    const reconcileResult = this.reconcileServiceCharacteristics(service, spec);
    const contexts = [];
    const values = {};
    let configStateChanged = false;

    for (const characteristic of service.characteristics) {
      const context = this.createCharacteristicContext(characteristic, spec);
      const defaultValue = this.defaultValueForCharacteristic(context, spec);
      const existingValue = this.normalizeIncomingValue(context, characteristic.value, spec);

      contexts.push(context);
      values[context.jsonKey] = defaultValue;

      if (this.isConfigDrivenContext(context) && !this.areValuesEqual(existingValue, defaultValue)) {
        configStateChanged = true;
      }

      if (context.readable) {
        characteristic.onGet(() => values[context.jsonKey]);
      }

      if (context.writable) {
        characteristic.onSet(async (value) => {
          await this.handleHomeKitSet(binding.bindingId, context, value);
        });
      }
    }

    const binding = {
      bindingId: spec.bindingId,
      accessory,
      service,
      spec,
      contexts,
      values,
      initializationRequired: Boolean(spec.isNewService || reconcileResult.structureChanged || configStateChanged),
    };

    this.applyStateToService(binding);
    this.bindings.set(binding.bindingId, binding);

    return binding;
  }

  reconcileServiceCharacteristics(service, spec) {
    const optionalKeys = this.resolveOptionalKeys(spec);
    const characteristicIndex = this.indexCharacteristicConstructors();
    const metadata = this.getServiceMetadata(spec.typeOf);
    const desiredOptionalUUIDs = new Set();
    let structureChanged = false;

    for (const key of optionalKeys) {
      const CharacteristicClass = characteristicIndex[key];
      if (!CharacteristicClass) {
        this.logDebug(`Characteristic constructor not found for ${key} on ${spec.displayName}.`);
        continue;
      }

      if (metadata.requiredUUIDs.has(CharacteristicClass.UUID)) {
        continue;
      }

      if (!metadata.allowedOptionalUUIDs.has(CharacteristicClass.UUID)) {
        this.log.warn(`[${PLATFORM_NAME}] Optional characteristic ${key} is not supported by ${spec.typeOf} for ${spec.displayName}.`);
        continue;
      }

      desiredOptionalUUIDs.add(CharacteristicClass.UUID);

      if (!service.testCharacteristic(CharacteristicClass)) {
        try {
          service.addCharacteristic(CharacteristicClass);
          structureChanged = true;
        } catch (error) {
          this.log.warn(`[${PLATFORM_NAME}] Unable to install optional characteristic ${key} on ${spec.displayName}: ${error.message}`);
        }
      }
    }

    for (const characteristic of [...service.characteristics]) {
      if (metadata.requiredUUIDs.has(characteristic.UUID)) {
        continue;
      }

      if (desiredOptionalUUIDs.has(characteristic.UUID)) {
        continue;
      }

      try {
        service.removeCharacteristic(characteristic);
        structureChanged = true;
      } catch (error) {
        this.logDebug(`Unable to remove characteristic ${characteristic.displayName} from ${spec.displayName}: ${error.message}`);
      }
    }

    return {
      structureChanged,
      desiredOptionalUUIDs,
      requiredUUIDs: metadata.requiredUUIDs,
    };
  }

  createCharacteristicContext(characteristic, spec) {
    const props = characteristic.props || {};
    const perms = Array.isArray(props.perms) ? props.perms : [];
    const readable = perms.includes('pr');
    const writable = perms.includes('pw');
    const jsonKey = characteristic.displayName;

    return {
      characteristic,
      jsonKey,
      format: props.format || '',
      props,
      readable,
      writable,
      lockToConfiguredName: jsonKey === 'Name' && spec.nameLocked,
      configDriven: ['Name', 'Is Configured', 'Service Label Index', 'Set Duration', 'Valve Type'].includes(jsonKey),
    };
  }

  applyStateToService(binding) {
    for (const context of binding.contexts) {
      const value = binding.values[context.jsonKey];
      if (value !== undefined) {
        context.characteristic.updateValue(value);
      }
    }

    binding.service.displayName = binding.spec.displayName;
    if (binding.service.testCharacteristic(this.Characteristic.Name)) {
      binding.service.updateCharacteristic(this.Characteristic.Name, binding.spec.displayName);
    }
  }

  async initializeBinding(binding) {
    await this.writeBindingToServer(binding, 'initial creation');
  }

  async handleHomeKitSet(bindingId, context, value) {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      return;
    }

    const normalized = this.normalizeIncomingValue(context, value, binding.spec);
    binding.values[context.jsonKey] = normalized;

    if (context.lockToConfiguredName) {
      binding.values[context.jsonKey] = binding.spec.displayName;
    }

    await this.writeBindingToServer(binding, `HomeKit update (${context.jsonKey})`);
  }

  async writeBindingToServer(binding, reason) {
    const payload = this.serializeBindingForServer(binding);
    const endpoint = this.buildServerEndpoint(binding.spec.token, 'update', binding.spec.vpin);
    const body = new URLSearchParams({
      value: JSON.stringify(payload),
    });

    try {
      const response = await this.fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
      }

      this.logDebug(`Server write completed for ${binding.spec.displayName} (${binding.spec.vpin}) - ${reason}`);
    } catch (error) {
      this.log.warn(`[${PLATFORM_NAME}] Failed to write ${binding.spec.displayName} (${binding.spec.vpin}): ${error.message}`);
    }
  }

  serializeBindingForServer(binding) {
    const payload = {};

    for (const context of binding.contexts) {
      let value = binding.values[context.jsonKey];
      if (context.lockToConfiguredName) {
        value = binding.spec.displayName;
      }
      payload[context.jsonKey] = this.serializeValueForServer(context, value);
    }

    return payload;
  }

  async pollAllBindings() {
    if (this.pollInFlight || this.bindings.size === 0) {
      return;
    }

    this.pollInFlight = true;

    try {
      for (const binding of this.bindings.values()) {
        await this.pollBinding(binding);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  async pollBinding(binding) {
    const endpoint = this.buildServerEndpoint(binding.spec.token, 'get', binding.spec.vpin);

    try {
      const response = await this.fetchWithTimeout(endpoint, { method: 'GET' });

      if (response.status === 404) {
        this.logDebug(`VPin ${binding.spec.vpin} is not initialized on the server for ${binding.spec.displayName}.`);
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      if (!json || Array.isArray(json) || typeof json !== 'object') {
        throw new Error('Server response is not a JSON object.');
      }

      this.applyServerPayload(binding, json);
    } catch (error) {
      this.logDebug(`Polling failed for ${binding.spec.displayName} (${binding.spec.vpin}): ${error.message}`);
    }
  }

  applyServerPayload(binding, payload) {
    let hasChange = false;

    for (const context of binding.contexts) {
      if (!Object.prototype.hasOwnProperty.call(payload, context.jsonKey)) {
        continue;
      }

      if (context.lockToConfiguredName) {
        continue;
      }

      const normalized = this.normalizeIncomingValue(context, payload[context.jsonKey], binding.spec);
      if (!this.areValuesEqual(binding.values[context.jsonKey], normalized)) {
        binding.values[context.jsonKey] = normalized;
        context.characteristic.updateValue(normalized);
        hasChange = true;
      }
    }

    if (hasChange) {
      this.logDebug(`Applied server changes to ${binding.spec.displayName} (${binding.spec.vpin}).`);
    }
  }

  startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const seconds = Math.max(1, Number(this.config.pollerseconds) || 10);
    this.pollTimer = setInterval(() => {
      void this.pollAllBindings();
    }, seconds * 1000);
  }

  collectDesiredAccessorySpecs() {
    const specs = [];
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    const claimedVpinsByToken = new Map();

    for (const device of devices) {
      const accessories = Array.isArray(device.accessories) ? device.accessories : [];
      let nextValveIndex = 1;
      const token = String(device.token || '').trim();
      const claimedVpins = claimedVpinsByToken.get(token) || new Set();
      claimedVpinsByToken.set(token, claimedVpins);

      for (const accessory of accessories) {
        const typeOf = String(accessory.typeOf || '').trim();
        if (!this.isSupportedType(typeOf)) {
          this.log.warn(`[${PLATFORM_NAME}] Unsupported accessory type skipped: ${typeOf || '(empty)'}.`);
          continue;
        }

        const pinNumber = this.normalizePinNumber(accessory.pinnumber);
        if (pinNumber === null) {
          this.log.warn(`[${PLATFORM_NAME}] Invalid accessory pin number for ${accessory.name || typeOf}.`);
          continue;
        }

        const vpin = `V${pinNumber}`;
        if (claimedVpins.has(vpin)) {
          this.log.warn(`[${PLATFORM_NAME}] Duplicate VPin ${vpin} skipped in device ${device.name || '(unnamed device)'}.`);
          continue;
        }
        claimedVpins.add(vpin);

        const displayName = this.normalizeDisplayName(accessory.name, `${typeOf} ${vpin}`);
        if (!token) {
          this.log.warn(`[${PLATFORM_NAME}] Missing token for accessory ${displayName}; skipped.`);
          continue;
        }
        const uuid = this.UUIDGen.generate(`arduino-esp:${token}:${device.deviceId || 0}:${vpin}`);

        const spec = {
          kind: typeOf === 'IRRIGATION_SYSTEM' ? 'irrigation' : 'single',
          uuid,
          token,
          deviceId: Number(device.deviceId) || 0,
          manufacturer: this.normalizeDisplayName(device.manufacturer, 'Arduino ESP'),
          model: this.normalizeDisplayName(accessory.model, typeOf),
          serialNumber: `device-${Number(device.deviceId) || 0}-vpin-${pinNumber}`,
          displayName,
          typeOf,
          vpin,
          optionalKeys: this.getEnabledKeys(accessory.characteristics, this.schemaMeta.accessoryOptionalKeys),
          forceOptionalKeys: typeOf === 'VALVE' ? ['Name', 'IsConfigured', 'ServiceLabelIndex', 'SetDuration'] : [],
          serviceLabelIndex: typeOf === 'VALVE' ? nextValveIndex++ : undefined,
          valveType: typeOf === 'VALVE' ? 1 : undefined,
          setDuration: typeOf === 'VALVE' ? 0 : undefined,
          primarySubtype: undefined,
          bindingId: `binding:${uuid}:primary`,
        };

        if (typeOf === 'VALVE') {
          spec.valveType = 1;
          spec.setDuration = 0;
        }

        if (typeOf === 'IRRIGATION_SYSTEM') {
          const valves = Array.isArray(accessory.valves) ? accessory.valves : [];
          spec.valves = [];

          for (const valve of valves) {
            const valvePinNumber = this.normalizePinNumber(valve.valvePinNumber);
            if (valvePinNumber === null) {
              this.log.warn(`[${PLATFORM_NAME}] Invalid irrigation valve pin number for ${valve.valveName || 'Valve'}.`);
              continue;
            }

            const valveVpin = `V${valvePinNumber}`;
            if (claimedVpins.has(valveVpin)) {
              this.log.warn(`[${PLATFORM_NAME}] Duplicate irrigation valve VPin ${valveVpin} skipped in device ${device.name || '(unnamed device)'}.`);
              continue;
            }
            claimedVpins.add(valveVpin);

            const valveDisplayName = this.normalizeDisplayName(valve.valveName, `Valve ${valveVpin}`);
            spec.valves.push({
              token,
              deviceId: Number(device.deviceId) || 0,
              manufacturer: spec.manufacturer,
              model: 'Valve',
              serialNumber: `${spec.serialNumber}-valve-${valvePinNumber}`,
              displayName: valveDisplayName,
              vpin: valveVpin,
              subtype: `valve:${valvePinNumber}`,
              optionalKeys: this.getEnabledKeys(valve.characteristics, this.schemaMeta.valveOptionalKeys),
              forceOptionalKeys: ['Name', 'IsConfigured', 'ServiceLabelIndex', 'SetDuration'],
              serviceLabelIndex: nextValveIndex++,
              valveType: this.normalizeInteger(valve.valveType, 1),
              setDuration: this.normalizeInteger(valve.valveSetDuration, 120),
              bindingId: `binding:${uuid}:valve:${valvePinNumber}`,
            });
          }
        }

        specs.push(spec);
      }
    }

    return specs;
  }

  resolveOptionalKeys(spec) {
    const keys = new Set();
    for (const key of spec.optionalKeys || []) {
      keys.add(key);
    }
    for (const key of spec.forceOptionalKeys || []) {
      keys.add(key);
    }
    return [...keys];
  }

  getEnabledKeys(source, allowedKeys) {
    const result = [];
    if (!source || typeof source !== 'object') {
      return result;
    }

    for (const key of allowedKeys) {
      if (source[key] === true || source[key] === 'true' || source[key] === 1 || source[key] === '1') {
        result.push(key);
      }
    }

    return result;
  }

  indexCharacteristicConstructors() {
    if (this.characteristicIndexCache) {
      return this.characteristicIndexCache;
    }

    const index = {};
    for (const key of [...this.schemaMeta.accessoryOptionalKeys, ...this.schemaMeta.valveOptionalKeys]) {
      if (this.Characteristic[key]) {
        index[key] = this.Characteristic[key];
      }
    }

    this.characteristicIndexCache = index;
    return index;
  }

  getServiceMetadata(typeOf) {
    if (!this.serviceMetadataCache) {
      this.serviceMetadataCache = new Map();
    }

    if (this.serviceMetadataCache.has(typeOf)) {
      return this.serviceMetadataCache.get(typeOf);
    }

    const ServiceClass = this.getServiceClass(typeOf);
    const tempService = new ServiceClass('__meta__', '__meta__');
    const metadata = {
      requiredUUIDs: new Set((tempService.characteristics || []).map((characteristic) => characteristic.UUID)),
      allowedOptionalUUIDs: new Set((tempService.optionalCharacteristics || []).map((characteristic) => characteristic.UUID)),
    };

    this.serviceMetadataCache.set(typeOf, metadata);
    return metadata;
  }

  isConfigDrivenContext(context) {
    return context.configDriven === true;
  }

  defaultValueForCharacteristic(context, spec) {
    switch (context.jsonKey) {
      case 'Name':
        return spec.displayName;
      case 'Is Configured':
        return 1;
      case 'Service Label Index':
        return this.normalizeInteger(spec.serviceLabelIndex, 1);
      case 'Set Duration':
        return this.normalizeInteger(spec.setDuration, 0);
      case 'Remaining Duration':
        return 0;
      case 'Valve Type':
        return this.normalizeInteger(spec.valveType, 1);
      default:
        return this.defaultValueFromProps(context.props, context.format);
    }
  }

  defaultValueFromProps(props, format) {
    const normalizedFormat = String(format || '').toLowerCase();

    if (normalizedFormat === 'string' || normalizedFormat === 'data' || normalizedFormat === 'tlv8') {
      return '';
    }

    if (normalizedFormat === 'bool') {
      return false;
    }

    const validValues = this.extractValidValues(props.validValues);
    if (validValues.length > 0) {
      return validValues[0];
    }

    if (Array.isArray(props.validValueRanges) && props.validValueRanges.length >= 2) {
      return props.validValueRanges[0];
    }

    if (typeof props.minValue === 'number') {
      return props.minValue;
    }

    return 0;
  }

  normalizeIncomingValue(context, rawValue, spec) {
    if (context.lockToConfiguredName) {
      return spec.displayName;
    }

    const format = String(context.format || '').toLowerCase();

    if (format === 'string' || format === 'data' || format === 'tlv8') {
      return rawValue == null ? '' : String(rawValue);
    }

    if (format === 'bool') {
      return rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1';
    }

    let numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      numericValue = this.defaultValueForCharacteristic(context, spec);
    }

    if (isIntegerFormat(format)) {
      numericValue = Math.round(numericValue);
    }

    const validValues = this.extractValidValues(context.props.validValues);
    if (validValues.length > 0 && !validValues.includes(numericValue)) {
      numericValue = validValues[0];
    }

    if (Array.isArray(context.props.validValueRanges) && context.props.validValueRanges.length >= 2) {
      numericValue = clamp(numericValue, context.props.validValueRanges[0], context.props.validValueRanges[1]);
    }

    if (typeof context.props.minValue === 'number') {
      numericValue = Math.max(context.props.minValue, numericValue);
    }

    if (typeof context.props.maxValue === 'number') {
      numericValue = Math.min(context.props.maxValue, numericValue);
    }

    return numericValue;
  }

  serializeValueForServer(context, value) {
    const format = String(context.format || '').toLowerCase();

    if (format === 'string' || format === 'data' || format === 'tlv8') {
      return value == null ? '' : String(value);
    }

    if (format === 'bool') {
      return value ? '1' : '0';
    }

    return String(value ?? 0);
  }

  buildServerEndpoint(token, action, vpin) {
    const base = String(this.config.serverurl || '').trim().replace(/\/+$/, '');
    if (base.toLowerCase().endsWith('/api.php')) {
      return `${base}?token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}&vpin=${encodeURIComponent(vpin)}`;
    }

    return `${base}/${encodeURIComponent(token)}/${encodeURIComponent(action)}/${encodeURIComponent(vpin)}`;
  }

  async fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  getServiceClass(typeOf) {
    const serviceName = SERVICE_NAME_MAP[typeOf];
    if (!serviceName || !this.Service[serviceName]) {
      throw new Error(`Unsupported service type: ${typeOf}`);
    }
    return this.Service[serviceName];
  }

  isSupportedType(typeOf) {
    return Boolean(SERVICE_NAME_MAP[typeOf] && this.Service[SERVICE_NAME_MAP[typeOf]]);
  }

  serviceKey(service) {
    return `${service.UUID}::${service.subtype || ''}`;
  }

  normalizeDisplayName(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
  }

  normalizePinNumber(value) {
    const pinNumber = Number(value);
    if (!Number.isInteger(pinNumber) || pinNumber < 0) {
      return null;
    }
    return pinNumber;
  }

  normalizeInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  extractValidValues(validValues) {
    if (Array.isArray(validValues)) {
      return validValues.filter((value) => typeof value === 'number');
    }

    if (validValues && typeof validValues === 'object') {
      return Object.values(validValues).filter((value) => typeof value === 'number');
    }

    return [];
  }

  areValuesEqual(a, b) {
    return Object.is(a, b);
  }

  logDebug(message) {
    if (this.config.debug) {
      this.log.info(`[${PLATFORM_NAME}] ${message}`);
    }
  }
}

function loadSchemaMeta(schemaPath) {
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const accessoryOptionalKeys = Object.keys(
      schema.schema.properties.devices.items.properties.accessories.items.properties.characteristics.properties,
    );
    const valveOptionalKeys = Object.keys(
      schema.schema.properties.devices.items.properties.accessories.items.properties.valves.items.properties.characteristics.properties,
    );

    return {
      accessoryOptionalKeys,
      valveOptionalKeys,
    };
  } catch (error) {
    return {
      accessoryOptionalKeys: [],
      valveOptionalKeys: [],
    };
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isIntegerFormat(format) {
  return ['int', 'uint8', 'uint16', 'uint32', 'uint64'].includes(String(format || '').toLowerCase());
}

module.exports = {
  ArduinoEspPlatform,
  PLATFORM_NAME,
  PLUGIN_NAME,
};
