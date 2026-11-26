import { describe, expect, it } from 'vitest';
import { editWudTechStack } from '@/server/application/wud-tech-stack';

const beszel = {
  path: 'flowvps/beszel/docker-compose.yml',
  service: 'beszel',
  before: 'docker.io/henrygd/beszel:0.21.0',
  after: 'docker.io/henrygd/beszel:0.21.2',
};

const files = {
  markdown: [
    'Portainer Stacks (from repo)',
    'flowvps (previously oracle-vps)',
    '- Proxmox VM/CT ID: external',
    '- beszel: henrygd/beszel:0.21.0 (current pin: 0.21.0)',
    '- beszel-agent: henrygd/beszel-agent:0.20.0',
    '',
    'oracle-vps',
    '- Proxmox VM/CT ID: external',
    '- beszel: henrygd/beszel:0.21.0',
    '',
  ].join('\r\n'),
  json: `{
  "stacks": [
    { "stack": "flowvps", "services": [
      { "name": "beszel",  "image" : "henrygd/beszel:0.21.0", "note": "henrygd/beszel:0.21.0" },
      { "name": "beszel-agent", "image": "henrygd/beszel-agent:0.20.0" }
    ] },
    {"stack":"oracle-vps","services":[{"name":"beszel","image":"henrygd/beszel:0.21.0"}]}
  ]
}`,
};

describe('WUD TechStack edits', () => {
  it('updates the FlowVPS Beszel pin in both documents and preserves unrelated bytes', () => {
    expect(editWudTechStack(files, [beszel])).toEqual({
      markdown: files.markdown.replace(
        '- beszel: henrygd/beszel:0.21.0 (current pin: 0.21.0)',
        '- beszel: henrygd/beszel:0.21.2 (current pin: 0.21.0)',
      ),
      json: files.json.replace('"image" : "henrygd/beszel:0.21.0"', '"image" : "henrygd/beszel:0.21.2"'),
    });
  });

  it('preserves the JSON repository spelling when the old tag uses an escape', () => {
    const rawPin = String.raw`henrygd\/beszel\u003a0.21.\u0030`;
    const json = files.json.replace('henrygd/beszel:0.21.0', rawPin);
    expect(editWudTechStack({ ...files, json }, [beszel]).json).toBe(
      json.replace(rawPin, String.raw`henrygd\/beszel\u003a0.21.2`),
    );
  });

  it('updates version literals in prefixed and grouped Markdown service entries', () => {
    const markdown = [
      '100-casaos',
      '- jellyaut gluetun: gluetun `v3.41.3`',
      '- jellyaut: jackett `0.24.3009-ls26`, radarr `0.24.3009-ls26`',
    ].join('\n');
    const json =
      '{"stacks":[{"stack":"100-casaos","services":[' +
      '{"name":"gluetun","image":"qmcgaw/gluetun:v3.41.3"},' +
      '{"name":"jackett","image":"linuxserver/jackett:0.24.3009-ls26"}]}]}';
    const path = '100-casaos/jellyaut/docker-compose.yml';
    expect(
      editWudTechStack({ markdown, json }, [
        {
          path,
          service: 'gluetun',
          before: 'docker.io/qmcgaw/gluetun:v3.41.3',
          after: 'docker.io/qmcgaw/gluetun:v3.41.4',
        },
        {
          path,
          service: 'jackett',
          before: 'docker.io/linuxserver/jackett:0.24.3009-ls26',
          after: 'docker.io/linuxserver/jackett:0.24.3010-ls26',
        },
      ]),
    ).toEqual({
      markdown: [
        '100-casaos',
        '- jellyaut gluetun: gluetun `v3.41.4`',
        '- jellyaut: jackett `0.24.3010-ls26`, radarr `0.24.3009-ls26`',
      ].join('\n'),
      json: json
        .replace('gluetun:v3.41.3', 'gluetun:v3.41.4')
        .replace('jackett:0.24.3009', 'jackett:0.24.3010'),
    });
  });

  it.each([
    ['`bellamy/wallos:4.9`', '`bellamy/wallos:5.11.3`'],
    ['wallos `4.9`', 'wallos `5.11.3`'],
    ['`5.10.0`', '`5.11.3`'],
    ['docker.io/bellamy/wallos:5.11.3', 'docker.io/bellamy/wallos:5.11.3'],
  ])('reconciles the Wallos inventory entry %s against Compose', (row, expected) => {
    const update = {
      path: '104-finances/wallos/docker-compose.yml',
      service: 'wallos',
      before: 'docker.io/bellamy/wallos:5.11.2',
      after: 'docker.io/bellamy/wallos:5.11.3',
    };
    const markdown = '104-finances\r\n- wallos: ' + row + ' (finance app)\r\n';
    const json =
      '{"stacks":[{"stack":"104-finances","services":[{"name":"wallos","image":"bellamy/wallos:4.10"}]}]}';
    expect(editWudTechStack({ markdown, json }, [update])).toEqual({
      markdown: markdown.replace(row, expected),
      json: json.replace(':4.10', ':5.11.3'),
    });
  });

  it.each([
    [
      'a missing Markdown stack',
      { ...files, markdown: files.markdown.replace('flowvps (previously oracle-vps)', 'other') },
    ],
    ['a Markdown example in a code fence', { ...files, markdown: '```md\r\n' + files.markdown + '```' }],
    ['a missing Markdown service', { ...files, markdown: files.markdown.replace('- beszel:', '- other:') }],
    [
      'a duplicate Markdown service with a conflicting pin',
      { ...files, markdown: files.markdown.replace('- beszel-agent:', '- beszel:') },
    ],
    [
      'a duplicate Markdown service without a pin',
      {
        ...files,
        markdown: files.markdown.replace('- beszel-agent: henrygd/beszel-agent:0.20.0', '- beszel:'),
      },
    ],
    [
      'a duplicate Markdown stack',
      { ...files, markdown: files.markdown.replace('\r\noracle-vps\r\n', '\r\nflowvps\r\n') },
    ],
    ['a missing JSON stack', { ...files, json: files.json.replace('"flowvps"', '"other"') }],
    ['a missing JSON service', { ...files, json: files.json.replace('"name": "beszel"', '"name": "other"') }],
    [
      'a different JSON image registry',
      { ...files, json: files.json.replace('"henrygd/beszel:', '"ghcr.io/henrygd/beszel:') },
    ],
    [
      'a duplicate JSON service with a conflicting pin',
      { ...files, json: files.json.replace('"name": "beszel-agent"', '"name": "beszel"') },
    ],
    ['a duplicate JSON stack', { ...files, json: files.json.replace('"oracle-vps"', '"flowvps"') }],
    [
      'a duplicate JSON image key',
      { ...files, json: files.json.replace('"image" :', '"image": "other:1.0", "image" :') },
    ],
    ['invalid JSON', { ...files, json: files.json.slice(0, -1) }],
  ])('refuses %s', (_, changedFiles) => {
    expect(() => editWudTechStack(changedFiles, [beszel])).toThrow();
  });

  it('refuses a version update that also changes repository', () => {
    expect(() => editWudTechStack(files, [{ ...beszel, after: 'ghcr.io/henrygd/beszel:0.21.2' }])).toThrow();
  });

  it('refuses multiple edits of a single documented pin', () => {
    expect(() =>
      editWudTechStack(files, [
        beszel,
        { ...beszel, path: 'flowvps/other/docker-compose.yml', after: 'docker.io/henrygd/beszel:0.21.3' },
      ]),
    ).toThrow();
  });
});
