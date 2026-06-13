const NORMAL_TEMPERATURE_C = 22;
const NORMAL_TEMPERATURE_F = NORMAL_TEMPERATURE_C * 9 / 5 + 32;
const NORMAL_CO2_PPM = 420;
const history = (value) => Array(24).fill(value);

const state = {
    power: false,
    autobrightness: true,
    brightness: 100,
    mode: 0,
    firstBoot: true,
    temperatureUnit: 0,
    environment: {
        temperature: {
            value: NORMAL_TEMPERATURE_C,
            history_24h: history(NORMAL_TEMPERATURE_C),
            diff: {
                type: 0,
                value: 0,
                inverse: false
            }
        },
        temperature_fahrenheit: {
            value: NORMAL_TEMPERATURE_F,
            history_24h: history(NORMAL_TEMPERATURE_F),
            diff: {
                type: 0,
                value: 0,
                inverse: false
            }
        },
        humidity: {
            value: 0,
            history_24h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            diff: {
                type: 0,
                value: 0,
                inverse: false
            }
        },
        co2: {
            value: NORMAL_CO2_PPM,
            history_24h: history(NORMAL_CO2_PPM),
            diff: {
                type: 0,
                value: 0,
                inverse: false
            }
        }
    },
    effects: {
        selected: 1
    },
    image: {
        selected: 1,
    },
    text: {
        payload: "Hello! 12345",
        size: 0,
    },
    settings: {
        calibration: {
            temperatureOffsetC: 0,
            humidityOffsetPct: 0,
            co2OffsetPpm: 0,
        },
        mqtt: {
            status: 0,
            host: 'mqtt-broker.example',
            port: 1883,
            client_id: 'client_id',
            username: 'username',
            password: 'password',
            co2_topic: 'co2',
            matrix_text_topic: 'text',
            show_text: false,
        },
        hass: {
            status: 0,
            show_text: false,
        },
        edmx: {
            protocol: 0,
            multicast: true,
            start_universe: 1,
            start_address: 1,
            mode: 0,
            timeout: 5000
        },
        scheduler: {
            enableDarkAutoPower: false,
            darkThresholdLux: 2,
            darkHysteresisLux: 0.5,
            darkStabilitySeconds: 15
        }
    },
};

const images = [
    {
        id: 1,
        name: 'Image 1',
        size: 200,
    },
    {
        id: 2,
        name: 'Image 2.gif',
        size: 200,
    },
    {
        id: 3,
        name: 'Image 3',
        size: 200,
    },
    {
        id: 4,
        name: 'Image 4',
        size: 200,
    },
    {
        id: 5,
        name: 'Image 5',
        size: 200,
    },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default [
    {
        url: '/openmatrix/state',
        method: 'get',
        response: () => {
            return {
                ...state
            }
        }
    },
    {
        url: '/openmatrix/power',
        method: 'post',
        response: ({ body }) => {
            state.power = body.power;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/autobrightness',
        method: 'post',
        response: ({ body }) => {
            state.autobrightness = body.autobrightness;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/brightness',
        method: 'post',
        response: ({ body }) => {
            state.brightness = body.brightness;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/mode',
        method: 'post',
        timeout: 1000,
        response: ({ body }) => {
            state.mode = body.mode;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/effect',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.effects.selected = body.effect;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/image',
        method: 'get',
        timeout: 1000,
        response: () => {
            return images;
        }
    },
    {
        url: '/openmatrix/image',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.image.selected = body.id;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }  
    },
    {
        url: '/openmatrix/image',
        method: 'patch',
        timeout: 1000,
        response: async (context) => {
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            }
        }
    },
    {
        url: '/openmatrix/text',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.text.payload = body.payload;
            state.text.size = body.size;

            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/mqtt',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.settings.mqtt = body;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/edmx',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.settings.edmx = body;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/hass',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.settings.hass = body;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/scheduler',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.settings.scheduler = body;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/calibration',
        method: 'post',
        timeout: 1000,
        response: async ({ body }) => {
            state.settings.calibration = body;
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/network/reset',
        method: 'post',
        timeout: 1000,
        response: () => {
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    },
    {
        url: '/openmatrix/settings/factory/reset',
        method: 'post',
        timeout: 1000,
        response: () => {
            return {
                code: 200,
                data: {
                    message: 'OK'
                }
            };
        }
    }
];
