'use strict';

const { ArduinoEspPlatform, PLATFORM_NAME, PLUGIN_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ArduinoEspPlatform);
};
