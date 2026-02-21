# Semantic Compression (Online)

Drop-in module for your online pipeline:

match -> semanticCompression -> reason

## Output (mandatory)
- compressed_bundle
- compression_manifest (v1.0)

## FilesR
- semanticCompressor.js
- manifestBuilder.js
- schemas/compression_manifest_v1.schema.json

## Quick test (standalone)
1) `node examples/run_demo.js`
