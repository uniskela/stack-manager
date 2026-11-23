import { describe, expect, it } from 'vitest';
import { editComposeImages } from '@/shared/compose-image-edits';

describe('editComposeImages', () => {
  it('changes only the selected images, preserving source bytes outside their tags', () => {
    const compose = [
      '# café',
      'services:',
      '    web:',
      '        image: "registry.example:5000/apps/web:1.2"   # web:1.2',
      '        env_file: .env.web',
      '        labels: [wud.watch=false]',
      '    worker:',
      "        image: 'worker:1.0'",
      '    untouched:',
      '        image: registry.example:5000/apps/web:1.2',
      '',
    ].join('\r\n');

    expect(
      editComposeImages(compose, [
        { service: 'worker', targetTag: 'v2026.11-cpu' },
        { service: 'web', targetTag: '2.0' },
      ]),
    ).toEqual({
      content: compose
        .replace('"registry.example:5000/apps/web:1.2"', '"registry.example:5000/apps/web:2.0"')
        .replace("'worker:1.0'", "'worker:v2026.11-cpu'"),
      changes: [
        {
          service: 'worker',
          before: 'worker:1.0',
          after: 'worker:v2026.11-cpu',
          currentTag: '1.0',
          targetTag: 'v2026.11-cpu',
        },
        {
          service: 'web',
          before: 'registry.example:5000/apps/web:1.2',
          after: 'registry.example:5000/apps/web:2.0',
          currentTag: '1.2',
          targetTag: '2.0',
        },
      ],
    });
  });

  it('appends an explicit tag to an implicit latest image in a flow mapping', () => {
    const compose = 'services: {app: {image: localhost:5000/demo}, other: {image: demo}}';
    expect(editComposeImages(compose, [{ service: 'app', targetTag: '3' }])).toEqual({
      content: 'services: {app: {image: localhost:5000/demo:3}, other: {image: demo}}',
      changes: [
        {
          service: 'app',
          before: 'localhost:5000/demo',
          after: 'localhost:5000/demo:3',
          currentTag: 'latest',
          targetTag: '3',
        },
      ],
    });
  });

  it('preserves an unrelated YAML anchor and alias', () => {
    const compose = 'x-labels: &labels {app: web}\nservices: {app: {image: demo:1, labels: *labels}}\n';
    expect(editComposeImages(compose, [{ service: 'app', targetTag: '2' }]).content).toBe(
      'x-labels: &labels {app: web}\nservices: {app: {image: demo:2, labels: *labels}}\n',
    );
  });

  it('preserves the header, comment and indentation of a block scalar', () => {
    const compose = 'services:\r\n  app:\r\n    image: >- # prefer demo:1\r\n      demo:1\r\n';
    expect(editComposeImages(compose, [{ service: 'app', targetTag: '2' }]).content).toBe(
      'services:\r\n  app:\r\n    image: >- # prefer demo:1\r\n      demo:2\r\n',
    );
  });

  it('preserves an escaped repository spelling inside a double-quoted scalar', () => {
    const compose = String.raw`services: {app: {image: "d\x65mo:1"}}`;
    expect(editComposeImages(compose, [{ service: 'app', targetTag: '2' }]).content).toBe(
      String.raw`services: {app: {image: "d\x65mo:2"}}`,
    );
  });

  it.each([
    ['invalid YAML', 'services: {app: {image: demo:1}\n'],
    ['duplicate services', 'services:\n  app: {image: demo:1}\n  app: {image: demo:2}\n'],
    ['duplicate image keys', 'services:\n  app:\n    image: demo:1\n    image: demo:2\n'],
    ['multiple YAML documents', 'services: {app: {image: demo:1}}\n---\n{}\n'],
    ['missing service', 'services: {other: {image: demo:1}}\n'],
    ['missing image', 'services: {app: {command: demo:1}}\n'],
    ['non-string image', 'services: {app: {image: 123}}\n'],
    ['invalid repository name', 'services: {app: {image: invalid/path/:1}}\n'],
    ['invalid current tag', 'services: {app: {image: demo:!invalid}}\n'],
    ['interpolated image', 'services: {app: {image: "demo:${TAG}"}}\n'],
    ['digest-pinned image', 'services: {app: {image: demo:1@sha256:' + 'a'.repeat(64) + '}}\n'],
    ['anchored image', 'services: {app: {image: &img demo:1}}\n'],
    ['aliased image', 'x-image: &img demo:1\nservices: {app: {image: *img}}\n'],
    ['anchored service', 'services: {app: &app {image: demo:1}}\n'],
    ['aliased service', 'x-app: &app {image: demo:1}\nservices: {app: *app}\n'],
    ['anchored services mapping', 'services: &services {app: {image: demo:1}}\n'],
    ['built service', 'services: {app: {image: demo:1, build: .}}\n'],
    ['extended service', 'services: {app: {image: demo:1, extends: other}}\n'],
    ['included Compose files', 'include: [other.yml]\nservices: {app: {image: demo:1}}\n'],
    ['merged service', 'services: {app: {image: demo:1, <<: {command: demo}}}\n'],
    [
      'merged YAML 1.1 service',
      '%YAML 1.1\n---\nx-common: &common {command: demo}\nservices: {app: {image: demo:1, <<: *common}}\n',
    ],
    ['tagged image', 'services: {app: {image: !reset demo:1}}\n'],
  ])('rejects %s', (_case, compose) => {
    expect(() => editComposeImages(compose, [{ service: 'app', targetTag: '2' }])).toThrow();
  });

  it.each([
    ['unchanged explicit tag', 'demo:1', '1'],
    ['unchanged implicit tag', 'demo', 'latest'],
    ['invalid target tag', 'demo:1', '2 # comment'],
  ])('rejects an %s', (_case, image, targetTag) => {
    expect(() =>
      editComposeImages(`services: {app: {image: ${image}}}`, [{ service: 'app', targetTag }]),
    ).toThrow();
  });

  it('rejects multiple edits for a single service', () => {
    expect(() =>
      editComposeImages('services: {app: {image: demo:1}}', [
        { service: 'app', targetTag: '2' },
        { service: 'app', targetTag: '3' },
      ]),
    ).toThrow();
  });
});
