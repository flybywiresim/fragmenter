'use strict';

// Babel is only used for jest
module.exports = {
    presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript',
    ],
};
