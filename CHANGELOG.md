# Changelog

## Unreleased

### BREAKING CHANGE: planned deployment provider result contract

The per-stack webhook provider API introduced by #54 permits `httpStatus: null` on a rejected result
when a local failure prevents sending. Integrations built against the earlier numeric-only plan must
check for null before processing HTTP codes and distinguish local rejection from an HTTP refusal.
Accepted results retain numeric HTTP statuses. No released deployment provider is affected because
#54 is the first implementation; this note documents compatibility for integrations based on the plan.

## [0.6.0](https://github.com/uniskela/stack-manager/compare/v0.5.0...v0.6.0) (2026-10-22)


### Features

* **dashboard:** simplify source workspace overview ([#63](https://github.com/uniskela/stack-manager/issues/63)) ([dc117cb](https://github.com/uniskela/stack-manager/commit/dc117cb5b79c6aa2e5a9af8221bb8f5f453cc8cd))
* **deployment:** add per-stack webhook bindings and manual triggers ([#65](https://github.com/uniskela/stack-manager/issues/65)) ([e75bda3](https://github.com/uniskela/stack-manager/commit/e75bda346a9b4dc00df9c6f9fe305c7687accd7f))
* **deployment:** add selective Git change routing and idempotency ([#66](https://github.com/uniskela/stack-manager/issues/66)) ([8333dd8](https://github.com/uniskela/stack-manager/commit/8333dd88d87834890dfcd58e7745e4c8d9994f20))
* **sync:** add durable-job repository fetch scheduler ([49f6cf3](https://github.com/uniskela/stack-manager/commit/49f6cf32df0498caec19e553eb437423356e8bc9))
* **sync:** add per-repository automatic fetch settings ([#62](https://github.com/uniskela/stack-manager/issues/62)) ([da55d99](https://github.com/uniskela/stack-manager/commit/da55d99c3616bc340d5a886b56a518fb1640bb10))
* **sync:** enqueue post-push refresh without changing push outcome ([5831a6c](https://github.com/uniskela/stack-manager/commit/5831a6c80cca8083eea42f2cd5d26578aa7cdbc6))
* **sync:** refresh source automatically after successful Git push ([f86c720](https://github.com/uniskela/stack-manager/commit/f86c72096dbf686d6be80819e464bd1a365ce83a))
* **sync:** schedule background Git fetches and refresh after push ([4c581a7](https://github.com/uniskela/stack-manager/commit/4c581a7a69b3b5dea595bf3f7713d37689aa1fb5))
* **sync:** start automatic repository fetch with worker ([62a1d62](https://github.com/uniskela/stack-manager/commit/62a1d6294365d006a4c9a574891925e47e7874f8))
* **sync:** validate automatic repository fetch settings ([818b1de](https://github.com/uniskela/stack-manager/commit/818b1de9a163b314b0c16fa1f7c6ad4b40f2c8fd))
* **sync:** wire automatic fetch scheduler into app container ([03fe969](https://github.com/uniskela/stack-manager/commit/03fe9690bac7e4c4c4e98822049c55bd30c3598d))
* **webhooks:** receive verified Git push events ([#64](https://github.com/uniskela/stack-manager/issues/64)) ([3e37b62](https://github.com/uniskela/stack-manager/commit/3e37b622e3d4ab1fb4cda3e181ab297c508e4ae1))


### Bug Fixes

* **ci:** send docs notifications to uniskela/com ([#44](https://github.com/uniskela/stack-manager/issues/44)) ([3c35f28](https://github.com/uniskela/stack-manager/commit/3c35f288501fb8da6174fdfc2a2023dd0a87e393))
* harden v0.6.0 release audit labels, tests and upgrade docs ([#67](https://github.com/uniskela/stack-manager/issues/67)) ([8ac0249](https://github.com/uniskela/stack-manager/commit/8ac0249406b1eb18be1e1e2914d8bef15f23645f))
* **security:** restrict dependency scripts and image publishing permissions ([#61](https://github.com/uniskela/stack-manager/issues/61)) ([dabf0c4](https://github.com/uniskela/stack-manager/commit/dabf0c4e60e68534550934d5ecb665afe129ef07))
* **sync:** preserve durable refresh requests and isolate scheduling failures ([6571fd2](https://github.com/uniskela/stack-manager/commit/6571fd2cd22a34680f13e139da19c62ed6048f03))


### Documentation

* add Context7 guidance for AI coding agents ([#39](https://github.com/uniskela/stack-manager/issues/39)) ([a06799f](https://github.com/uniskela/stack-manager/commit/a06799f40a3795f23d0ddc476d99b1d6405bbdc4))
* **plan:** scope v0.6.0 Git automation and selective deployment ([#58](https://github.com/uniskela/stack-manager/issues/58)) ([5198faf](https://github.com/uniskela/stack-manager/commit/5198faf963a4082cb76a4d6b43b93b98ae93b2aa))
* separate public, internal and agent documentation ([#42](https://github.com/uniskela/stack-manager/issues/42)) ([83fe850](https://github.com/uniskela/stack-manager/commit/83fe850c381de44b7897067114c1f39a31617148))
* **sync:** document scheduled repository fetching ([3d84354](https://github.com/uniskela/stack-manager/commit/3d843547acb0f518b5467e26e8b30ba85216911c))
* **sync:** explain automatic fetch and manual fallback ([35ce560](https://github.com/uniskela/stack-manager/commit/35ce5604579101d8a94da0a10acf890898f05469))
* **sync:** explain automatic fetch and manual fallback ([609c788](https://github.com/uniskela/stack-manager/commit/609c788599803a9b0dfae324e8d0cf7c4bfa3b90))
* **sync:** explain automatic fetch and manual fallback ([d6906c2](https://github.com/uniskela/stack-manager/commit/d6906c2d7de886b34761d1c9e373c6c97a2a6f91))
* **sync:** explain automatic fetch and manual fallback ([5df54be](https://github.com/uniskela/stack-manager/commit/5df54be9ddbe94cfcef8f4c0c0aa9c13b4c6a5c6))

## [0.5.0](https://github.com/uniskela/stack-manager/compare/v0.4.0...v0.5.0) (2026-10-07)


### Features

* add commit and push workflow to Changes ([#35](https://github.com/uniskela/stack-manager/issues/35)) ([3ed4734](https://github.com/uniskela/stack-manager/commit/3ed4734b069c4af117afce14986150656d5715cd))
* add draft commit and safe push workflow ([#31](https://github.com/uniskela/stack-manager/issues/31)) ([a4daf5d](https://github.com/uniskela/stack-manager/commit/a4daf5d7b004f46c8e978cdcd6da70ba873387aa))
* add Git author identity settings ([#34](https://github.com/uniskela/stack-manager/issues/34)) ([aa740b0](https://github.com/uniskela/stack-manager/commit/aa740b07df6a4385c099f3d39bcf4ceef5d49feb))
* add safe Git mutation foundation ([#29](https://github.com/uniskela/stack-manager/issues/29)) ([26d688f](https://github.com/uniskela/stack-manager/commit/26d688f4a442ae01aa73cb18fe84e134e9576914))
* add stack history and change indicators ([#36](https://github.com/uniskela/stack-manager/issues/36)) ([57fb19d](https://github.com/uniskela/stack-manager/commit/57fb19d257d0832a683101951f5f7c1e9bb770c6))
* add stack-scoped Git history API ([#32](https://github.com/uniskela/stack-manager/issues/32)) ([d7f872d](https://github.com/uniskela/stack-manager/commit/d7f872d29540ee3f6770b1d6c908612c298b3c9c))


### Bug Fixes

* stop the Git workflow getting stuck after a push or page reload ([#37](https://github.com/uniskela/stack-manager/issues/37)) ([ae0adb1](https://github.com/uniskela/stack-manager/commit/ae0adb1f3ae9187287ee493dbe294d42e74e96e7))


### Documentation

* prepare v0.5.0 Git workflow release ([#38](https://github.com/uniskela/stack-manager/issues/38)) ([b240abe](https://github.com/uniskela/stack-manager/commit/b240abed002172188b426759af50171b236762ec))

## [0.4.0](https://github.com/uniskela/stack-manager/compare/v0.3.0...v0.4.0) (2026-09-30)


### Features

* clearer stacks list with repository cards and parent-folder groups ([#19](https://github.com/uniskela/stack-manager/issues/19)) ([#23](https://github.com/uniskela/stack-manager/issues/23)) ([77a18c5](https://github.com/uniskela/stack-manager/commit/77a18c53569aee82f7613670d9704756567dcd53))
* stack breadcrumbs, sibling switcher and list keyboard navigation ([#24](https://github.com/uniskela/stack-manager/issues/24)) ([e00521f](https://github.com/uniskela/stack-manager/commit/e00521fd3fb8f2f286d4e7d37789004def0e6c7a))
* stacks list filters, sort, grouping and shareable URL state ([#20](https://github.com/uniskela/stack-manager/issues/20)) ([de595d9](https://github.com/uniskela/stack-manager/commit/de595d94a1c089d95dc4b7a2140db7b00ceacc53))


### Bug Fixes

* stacks list search, natural ordering and result count ([#17](https://github.com/uniskela/stack-manager/issues/17)) ([38ff728](https://github.com/uniskela/stack-manager/commit/38ff728b0cb9935ef1e1a00e9ae56a46060f624a))
* stop draft audit assertion from matching timestamps ([#26](https://github.com/uniskela/stack-manager/issues/26)) ([719f3da](https://github.com/uniskela/stack-manager/commit/719f3da1fb2e50ecf7262cffd4054d82f4714545))


### Documentation

* how to find a stack, and the Stacks page UX ([#25](https://github.com/uniskela/stack-manager/issues/25)) ([7c1c932](https://github.com/uniskela/stack-manager/commit/7c1c9321df932449e1ed413578de603921a4ad90))

## [0.3.0](https://github.com/uniskela/stack-manager/compare/v0.2.0...v0.3.0) (2026-09-30)


### Features

* dashboard home, organised stacks, and settings split ([#15](https://github.com/uniskela/stack-manager/issues/15)) ([105b855](https://github.com/uniskela/stack-manager/commit/105b8554a4e7501f0f0fe53823890fec27646d74))

## [0.2.0](https://github.com/uniskela/stack-manager/compare/v0.1.0...v0.2.0) (2026-09-30)


### Features

* auto-add stacks, paginated stack list and repository-wide files ([#13](https://github.com/uniskela/stack-manager/issues/13)) ([6daefc6](https://github.com/uniskela/stack-manager/commit/6daefc60f7f59b7324508d8f7e5fe2d52c7a15c0))


### Documentation

* use generic example stacks ([#11](https://github.com/uniskela/stack-manager/issues/11)) ([0e6f986](https://github.com/uniskela/stack-manager/commit/0e6f986bd858be7d3ad0df7c060dfc6ce7122b9a))

## 0.1.0 (2026-09-29)


### Features

* **release:** automated releases, security scanning and GHCR images ([#6](https://github.com/uniskela/stack-manager/issues/6)) ([3bae738](https://github.com/uniskela/stack-manager/commit/3bae738e9469240720c4484a75834d4450ccdc16))


### Documentation

* publish user documentation to uniskela.com ([#9](https://github.com/uniskela/stack-manager/issues/9)) ([5c86fe1](https://github.com/uniskela/stack-manager/commit/5c86fe1c55f04c3bd076da4aecebdf87cc670acd))
