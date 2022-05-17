![FlyByWire Simulations](https://raw.githubusercontent.com/flybywiresim/branding/1391fc003d8b5d439d01ad86e2778ae0bfc8b682/tails-with-text/FBW-Color-Light.svg#gh-dark-mode-only)
![FlyByWire Simulations](https://github.com/flybywiresim/branding/blob/master/tails-with-text/FBW-Color-Dark.svg#gh-light-mode-only)


# FlyByWire Simulations Fragmenter

## Modules / fragments

A module is the zipped content of it's relative `sourceDir` specified in the [`buildManifest`](#2-create-a-buildmanifest). It also includes a `module.json` file which contains the hash of this specific module in order to be able to check for mismatches between the downloaded file and [`modules.json`](#the-modulesjson-file) on the server. The full module includes all modules and allows a faster initial installation. The base module includes every file of a package which is not part of another module.

## Installation

Install the library using npm:
```shell
$ npm install --save @flybywiresim/fragmenter
```
## How to use fragmenter to pack files

### 1. Create a .js file and import fragmenter
```ts
const fragmenter = require('@flybywiresim/fragmenter');
```
### 2. Create a buildManifest:

The buildManifest has the following attributes:

- `baseDir: string` 

    input directory for files before packing / directory of the baseModule (everything which is not included in another module)

 - `outDir: string`

    output directory for packed modules and modules.json file

- `modules: Module[]`
    
    `Module: {`
    
    `   name: string;` unique module name
    
    `   sourceDir: string; ` a module's relative source directory to baseDir (currently modules cannot be located within other modules)
    
    `}`

Example:

```ts
const buildManifest = {
    baseDir: './in',
    outDir: './out',
    modules: [{
        name: 'a',
        sourceDir: './a',
    }, {
        name: 'b',
        sourceDir: './b',
    }, {
        name: 'c',
        sourceDir: './c',
    }],
}
```

### 3. Use the buildManifest within the `pack()` function

```ts
fragmenter.pack(buildModules);
```
`pack()` is an async function which builds the modules. It's promised return value is the DistributionManifest Object (modules.json). The only attribute it expects is the buildModules object.

Alltogether your simplified `fragment.js` file could look like this for example:
```ts
const fragmenter = require('@flybywiresim/fragmenter')

fragmenter.pack({
    baseDir: './in',
    outDir: './out',
    modules: [{
        name: 'a',
        sourceDir: './a',
    }, {
        name: 'b',
        sourceDir: './b',
    }, {
        name: 'c',
        sourceDir: './c',
    }],
});
```

## How to host fragmenter modules

All files of one package located inside `outDir` need to be hosted within the same directory. Multiple packages cannot be hosted within the same directory. To allow updates, the URL requires to be consistent for all future builds (e.g. no versioning within the URL).

## The modules.json file

(also reffered to as `distributionManifest`)

This file is created during packing and located within your outDir. It indicates the current contents of a package. The structure of this file is similar to the buildManifest but most importantly it serves a hash value for each module. In case a module's hash in this file is different than inside the [installManifest](#-the-install.json-file) an update is required.

The `base` Module will have all it's contents listed by relative paths, as this module contains everything which is not included within another module.

You will notice a `fullHash` too which is used for the full module. It contains all the modules to allow for a faster initial installation.

Example:

```json
{
  "modules": [
    {
      "name": "a",
      "sourceDir": "./a",
      "hash": "4ef423207634ca62d7cf5628dd49871ec30f29bd581e49a078d2ec3be5afb7b71e53a4437c3efa2ad0f1e42e754aa2f99e48f26fd580418384ed49ba169d13fd"
    },
    {
      "name": "b",
      "sourceDir": "./b",
      "hash": "73126ef258257bb2f8d97359782276450b96b7499c529f5440ca0aa9f6545a41462f07797d05665b06bcdf2ef69e695e3f213f0c6f1acb3c23da5339cf9b9108"
    },
    {
      "name": "c",
      "sourceDir": "./c",
      "hash": "c6b96f747990eac5acce7e29409245858e45cf93f5a2ddd4ec16ebc22a3863457d0ebdaf7a5d29b7e51edab930e3129c4c867b21b9837083dc4c2b995c00990e"
    }
  ],
  "base": {
    "hash": "c66ac1e5c010060c460d72ee94034f0fff3dffc9ef762502611876fcba444c9d7b5a761952a906175db7e96243b8d93651a0468d3e768709eb7895f36c35ad67",
    "files": ["path/to/anyFile.txt", "module.json"]
  },
  "fullHash": "7a8192768029ad9bd0aff064df12568aeea22573fe12eda88898687232e8cefdb759bf2cbd7795fa5840be1c6886025b86d621c76869df996a18260c535c761c"
}
```

## The install.json file

(also reffered to as `installManifest`)

This file is used to determine the currently installed modules of a package and to detect mismatches of hash values in comparison to the newest modules on the server.
It's structure is similar to the [`modules.json`](#the-modulesjson-file) file, but it also includes a source property. This is the origin URL of the last installation and is used to determine what version/edition is installed. After an update, this file will be updated according to the modules.json file on the server to match the newly installed modules and it's corresponding hashes.



