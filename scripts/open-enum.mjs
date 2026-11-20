// An open enum is published as anyOf [{enum: [...]}, {type: string}] (with x-extensible-enum), a
// closed one as a plain enum. The values listed today are the plain enum, else the anyOf member that
// carries one; undefined when the schema lists none, so a caller can refuse rather than read empty.
export const listedValues = (schema) => schema?.enum ?? schema?.anyOf?.find((part) => Array.isArray(part?.enum))?.enum;
