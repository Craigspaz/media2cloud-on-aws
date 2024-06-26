// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('fs');
const PATH = require('path');
const CRYPTO = require('crypto');
const GLOB = require('glob');
const Terser = require('terser');
const RollupStream = require('@rollup/stream');

const COMMAND = {
  MINIFY: 'minify',
  INJECTSRI: 'inject-sri',
  ROLLUP: 'rollup',
  BUILDHTML: 'build-html',
};

const EXTERNAL_IMPORTS = [
  '/solution-manifest.js',
  '/third_party/dist/js/timecode.min.js',
];

function usage(message) {
  if (message) {
    console.error(`ERROR: ${message}`);
  }
  const script = PATH.parse(process.argv[1]).base;
  console.log(`
Usage:
node ${script} <command> <options>

where:
  <command>              specify ${Object.values(COMMAND).join(', ')}

  ${COMMAND.ROLLUP} <options>
    --input <FILE_NAME>   [mandatory] the top-level source file name; ie., src/lib/js/app.js
    --output <FILE_NAME>  [mandatory] output file name; ie., src/lib/js/app.rollup.js

  ${COMMAND.BUILDHTML} <options>
    --html <INDEX_HTML>  [mandatory] build production index.html and inject SRI code

  ${COMMAND.MINIFY} <options>
    --dir <APP_DIR>      [mandatory] the top-level app name; ie., src/lib/js/

  ${COMMAND.INJECTSRI} <options>
    --html <INDEX_HTML>  [mandatory] inject SRI code

  `);
  process.exit(1);
}

function parseCmdline() {
  const options = {};
  const args = process.argv.slice(2);
  const command = args.shift();
  while (args.length) {
    options[args.shift().slice(2)] = args.shift();
  }
  if (command === COMMAND.ROLLUP) {
    if (!options.input) {
      return usage('\'--input\' must be specified');
    }
    if (!options.output) {
      return usage('\'--output\' must be specified');
    }
  } else if (command === COMMAND.BUILDHTML) {
    if (!options.html) {
      return usage('\'--html\' must be specified');
    }
  } else if (command === COMMAND.MINIFY) {
    if (!options.dir) {
      return usage('\'--dir\' must be specified');
    }
  } else if (command === COMMAND.INJECTSRI) {
    if (!options.html) {
      return usage('\'--html\' must be specified');
    }
  } else {
    return usage(`command '${command}' not supported`);
  }
  options.command = command;
  return options;
}

async function injectSRICommand(options) {
  const original = PATH.resolve(options.html);
  const buffer = createBackupCopy(original);
  const output = [];
  const rootDir = PATH.parse(original).dir;
  const lines = buffer.toString().split('\n');
  while (lines.length) {
    const line = lines.shift();
    if (line.indexOf('%SRI%') < 0) {
      output.push(line);
      continue;
    }
    if (line.indexOf('<script') >= 0) {
      output.push(insertSRI(line, rootDir, /src="([^"]+)"/));
    } else if (line.indexOf('<link') >= 0) {
      output.push(insertSRI(line, rootDir, /href="([^"]+)"/));
    } else {
      throw new Error('only support <script> and <link> tags');
    }
  }
  // overwrite original file
  FS.writeFileSync(original, output.join('\n'));
}

async function rollupCommand(options) {
  console.log(`>>> rollup ${options.input} BEGIN...`);
  const output = await new Promise((resolve, reject) => {
    const stream = RollupStream({
      input: PATH.resolve(options.input),
      output: {
        format: 'es',
      },
      external: EXTERNAL_IMPORTS,
    });
    let bundle = '';

    stream.on('data', (data) =>
      (bundle += data));
    stream.on('end', () =>
      resolve(bundle.split('\n')));
    stream.on('error', e =>
      reject(e));
  });

  if (!output || output.findIndex((x) => x.indexOf('import SolutionManifest') >= 0) < 0) {
    throw new Error(`fail to rollup ${options.input}`);
  }

  /* convert relative path to absolute path for the external libraries */
  EXTERNAL_IMPORTS.forEach((external) => {
    const idx = output
      .findIndex((x) =>
        x.indexOf(external) > 0);
    if (idx >= 0) {
      output[idx] = output[idx].replace(/(\.\.\/)+/g, '/');
    }
  });
  console.log(`>>> rollup ${options.input} END...`);

  console.log('>>> terser.minify BEGIN...');
  const minified = Terser.minify(output.join('\n'), {
    ecma: 6,
    // keep_classnames: true,
    // warnings: 'verbose',
  });
  if (minified.error) {
    throw minified.error;
  }
  console.log('>>> terser.minify END...');
  FS.writeFileSync(PATH.resolve(options.output), minified.code);
  return options.output;
}

// eslint-disable-next-line
// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
async function minifyJSCommand(options) {
  // eslint-disable-next-line
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  let parsed = PATH.parse(PATH.resolve(options.dir));
  if (parsed.ext.length > 0) {
    parsed = parsed.dir;
  } else {
    // eslint-disable-next-line
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    parsed = PATH.join(parsed.dir, parsed.base);
  }

  const files = await new Promise((resolve, reject) => {
    // eslint-disable-next-line
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    GLOB(PATH.join(parsed, '**/*.js'), (e, data) =>
      ((e)
        ? reject(e)
        : resolve(data)));
  });

  files.forEach((file) => {
    console.log(`>>> processing ${file}...`);
    const result = Terser.minify(FS.readFileSync(file, 'utf8'), {
      ecma: 6,
      // keep_classnames: true,
      // warnings: 'verbose',
    });
    if (result.error) {
      throw result.error;
    }
    FS.writeFileSync(file, result.code);
  });
}

async function buildHtmlCommand(options) {
  const original = PATH.resolve(options.html);
  const buffer = createBackupCopy(original);
  const output = [];
  const rootDir = PATH.parse(original).dir;
  const lines = buffer.toString().split('\n')
    .filter(x => x && x.length);
  while (lines.length) {
    let line = lines.shift().trim();
    if (line.indexOf('REPLACE=') > 0) {
      const matched = line.match(/REPLACE={{([^}]+)}}/);
      if (matched && matched[1]) {
        line = matched[1];
        output.push(insertSRI(line, rootDir, /src="([^"]+)"/));
        continue;
      }
    }
    if (line.indexOf('%SRI%') < 0) {
      output.push(line);
      continue;
    }
    if (line.indexOf('<script') >= 0) {
      output.push(insertSRI(line, rootDir, /src="([^"]+)"/));
    } else if (line.indexOf('<link') >= 0) {
      output.push(insertSRI(line, rootDir, /href="([^"]+)"/));
    } else {
      throw new Error('only support <script> and <link> tags');
    }
  }
  // overwrite original file
  FS.writeFileSync(original, output.join('\n'));
}

function computeFileSHA384(path) {
  const buf = FS.readFileSync(path);
  const digest = CRYPTO.createHash('sha384').update(buf, 'utf-8').digest('hex');
  return Buffer.from(digest, 'hex').toString('base64');
}

function insertSRI(line, rootDir, regex) {
  const found = line.match(regex);
  if (!found) {
    throw new Error(`failed to find tag: ${line}`);
  }
  const idx = line.indexOf('>');
  if (idx < 0) {
    throw new Error(`failed to find '>' enclose tag: ${line}`);
  }

  // eslint-disable-next-line
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const path = PATH.resolve(PATH.join(rootDir, found[1]));
  const integrity = computeFileSHA384(path);
  return [
    line.substring(0, idx),
    ` integrity="sha384-${integrity}"`,
    line.substring(idx),
  ].join('');
}

function createBackupCopy(path) {
  const buffer = FS.readFileSync(path);
  // FS.writeFileSync(`${path}.bak`, buffer);
  return buffer;
}

(async () => {
  process.on('uncaughtException', (e) => {
    console.error('There was an uncaught error', e);
    process.exit(1);
  });

  const options = parseCmdline();
  if (options.command === COMMAND.ROLLUP) {
    return rollupCommand(options);
  }
  if (options.command === COMMAND.BUILDHTML) {
    return buildHtmlCommand(options);
  }
  if (options.command === COMMAND.MINIFY) {
    return minifyJSCommand(options);
  }
  if (options.command === COMMAND.INJECTSRI) {
    return injectSRICommand(options);
  }
  return usage(`command '${options.command}' not supported`);
})();
