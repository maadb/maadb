/** Synthetic multi-type schemas; no production data or private schema sources. */
export function contractCorpus(types = 24): Record<string, string> {
  const files: Record<string, string> = {};
  let registry = 'types:\n';
  for (let i = 0; i < types; i++) {
    const name = i === 0 ? 'note' : `record_${i}`;
    const prefix = i === 0 ? 'nt' : `r${i}`;
    registry += `  ${name}:\n    path: ${name}s\n    id_prefix: ${prefix}\n    schema: ${name}.v1\n`;
    let schema = `type: ${name}\nversion: 1\nrequired: [title]\nfields:\n  title:\n    type: string\n    index: true\n`;
    for (let f = 0; f < 16; f++) {
      schema += `  field_${f}:\n` + (f % 4 === 0 ? '    type: enum\n    values: [open, active, closed]\n    index: true\n'
        : f % 4 === 1 ? '    type: string\n    max_length: 1024\n    multiline: false\n'
          : f % 4 === 2 ? '    type: list\n    item_type: string\n' : '    type: date\n    store_precision: day\n');
    }
    files[`_schema/${name}.v1.yaml`] = schema;
  }
  files['_registry/object_types.yaml'] = registry;
  return files;
}
