# React Native Radar — March 11, 2026

Date: 2026-03-11

Welcome to your weekly pulse on React Native: engine swaps, tooling wins, platform expansions, and the occasional security fire drill. This edition rounds up the big releases (Hermes goes default), Expo and navigation updates that make building nicer, VR and security headlines, and a scattering of industry noise to keep you informed without drowning in feeds.

## Version Control: Core Releases & Engine Upgrades
*Hermes goes mainstream — version bumps, performance wins, and the quiet panic of CI pipelines trying to keep up.*

- React Native 0.84 - Hermes V1 by Default · React Native  
  React Native 0.84 is out and now ships Hermes V1 as the default JavaScript engine on both iOS and Android, delivering notable performance improvements. The release also removes legacy architecture components, ships precompiled iOS binaries by default, and bumps the minimum Node.js requirement to 22. Source: [reactnative.dev](https://reactnative.dev/blog/2026/02/11/react-native-0.84)

- Release React Native 0.84. React Native 0.84 has arrived, marking… | by Onix React · Medium  
  A developer-focused recap of 0.84 highlights the Hermes transition and developer experience upgrades, calling out improved debugging and compatibility with modern JS standards. The piece is practical for teams planning migration and CI adjustments. Source: [medium.com](https://medium.com/@onix_react/release-react-native-0-84-4163b8efcd74)

- React Native 0.83 - React 19.2, New DevTools features, no breaking changes · React Native  
  Version 0.83 introduced React 19.2 and enhanced DevTools, bringing stable Web Performance APIs and experimental Intersection Observer support for Canary builds — and notably shipped with no user-facing breaking changes. It set the stage for 0.84’s engine move while keeping upgrades low-friction. Source: [reactnative.dev](https://reactnative.dev/blog/2025/12/10/react-native-0.83)

- React Native 0.81 - Android 16 support, faster iOS builds, and more · React Native  
  0.81 added Android 16 (API 36) support and experimental iOS precompilation to speed up builds, along with stability and community-maintained JavaScriptCore work. The release also began phasing out older components, signaling the project’s push toward modern runtimes. Source: [reactnative.dev](https://reactnative.dev/blog/2025/08/12/react-native-0.81)

- Google News - Search (React Native updates roundup)  
  A rolling news feed of React Native coverage, collecting articles about recent version releases, architecture shifts, and community moves — useful if you want a meta-view of press and commentary across outlets. Keep an eye here for emerging stories and broader industry takes. Source: [news.google.com](https://news.google.com/search?q=react%20native%20news&hl=en-US&gl=US&ceid=US:en)

## Toolbox Reforged: Expo, Routers & Native UI
*Expo gets bolder, routers get craftier, and navigation learns some new tricks — building apps just became more satisfying (and slightly more magical).*

- Expo SDK 55 - Expo Changelog  
  Expo SDK 55 ships with React Native 0.83 support and multiple improvements aimed at smoothing typical mobile workflows; Expo notes that RN 0.84 is available on SDK 56 canaries with an official SDK 56 planned for Q2. The SDK continues to be the fast path for teams that want smooth upgrades and batteries-included tooling. Source: [expo.dev](https://expo.dev/changelog/sdk-55)

- Expo SDK 55 Just Dropped — Here’s Why React Native Will Never Be the Same | by GDSKS · Medium  
  A feature-forward take that frames SDK 55 as a turning point for Expo’s integration with React Native, highlighting developer ergonomics and platform capabilities that cut friction for app teams. Good read if you want opinions on why Expo’s momentum matters. Source: [gdsks.medium.com](https://gdsks.medium.com/expo-sdk-55-just-dropped-heres-why-react-native-will-never-be-the-same-c31cb9d0a17c)

- Expo Router v55: more native navigation, more powerful web  
  Expo Router v55 adds a new Stack API, native tabs, dynamic platform colors, and toolbars; it also experiments with SSR and data loaders to improve web parity and DX for universal apps. The router is becoming more capable for teams building apps that must feel native across platforms. Source: [expo.dev](https://expo.dev/blog/expo-router-v55-more-native-navigation-more-powerful-web)

- Native React Native components, Google Sign-In, and Core 3 · Clerk Changelog  
  @clerk/expo 3.0 brings native UI components built with SwiftUI and Jetpack Compose, native Google Sign-In, and the Core-3 Signal API — a major push toward first-party native UI and auth flows within Expo apps. This is timely for teams wanting native polish without ejecting. Source: [clerk.com](https://clerk.com/changelog/2026-03-09-expo-native-components)

- React Navigation 8.0 - March Progress Report | React Navigation  
  The March update on React Navigation 8.0 highlights improved deep linking, stronger TypeScript support, and modern React features like React.Activity and Suspense integration; it now requires React 19+. Navigation continues to modernize alongside the React and RN core. Source: [reactnavigation.org](https://reactnavigation.org/blog/2026/03/10/react-navigation-8.0-march-progress)

## Platform Expansion & Security Alarms
*VR on Quest, crypto alliances, and supply-chain gremlins — new frontiers collide with sobering CVEs and eyebrow-raising exploits.*

- React Native Comes to Meta Quest · React Native  
  React Native support for Meta Quest opens up VR app development with the same React paradigms, enabling cross-platform reach from mobile and web to headset experiences announced at React Conf 2025. Expect tooling and input abstractions to evolve as developers prototype immersive UIs. Source: [reactnative.dev](https://reactnative.dev/blog/2026/02/24/react-native-comes-to-meta-quest)

- CVE-2025-11953 Critical RCE in React Native CLI · JFrog Blog  
  A critical remote code execution vulnerability in @react-native-community/cli (CVE-2025-11953) was disclosed, affecting a widely used CLI and risking arbitrary OS command execution on developers’ machines — a major supply-chain issue for RN projects. Immediate remediation and dependency audits are strongly advised for teams. Source: [jfrog.com](https://jfrog.com/blog/CVE-2025-11953-critical-react-native-community-cli-vulnerability)

- New ‘Powerful’ iOS Attack Warning Issued To Millions Of iPhone Users · Forbes  
  Forbes reports on a sophisticated iOS exploitation kit that targets users while attempting to detect Lockdown Mode or private browsing, using unique cookies and evasive behaviors — a reminder that mobile ecosystems remain high-value targets. While not exclusive to React Native, this raises platform risk considerations for mobile apps and their users. Source: [forbes.com](https://www.forbes.com/sites/kateoflahertyuk/2026/03/07/new-powerful-ios-attack-warning-issued-to-millions-of-iphone-users/)

- OAuth vulnerability in n8n automation platform could lead to system compromise · CSO Online  
  A reported OAuth flaw in the n8n automation platform could allow attackers to compromise integrated systems; for teams using automation tools with React Native backends, this underlines the need to vet third-party services and tokens in CI/CD and production. The write-up is a useful reminder about automation-chain security. Source: [csoonline.com](https://www.csoonline.com/article/4141867/oauth-vulnerability-in-n8n-automation-platform-could-lead-to-system-compromise.html)

- Pharos Network Welcomes TopNod to RealFi Alliance to Scale Self-Custodial Infrastructure · MEXC  
  A blockchain/RealFi industry update: Pharos Network’s RealFi Alliance adds TopNod to scale self-custodial infrastructure — contextually interesting for teams integrating crypto features or wallet flows into mobile apps. It signals continued crypto infrastructure maturation that some React Native apps may tap into. Source: [mexc.com](https://www.mexc.com/news/872498)

## The Static: Ads, Headlines & Other Noise
*Apple ads, event recaps, and political headlines — the kind of tech clutter that shows up in feeds while you’re trying to read release notes.*

- New Audible Feature, Smartphones in Space and More | Tech Today - CNET  
  A CNET Tech Today roundup covering consumer tech bites — from Audible features to other gadget news — useful for light reading but peripheral to core React Native work. It’s the kind of background tech noise that fills newsfeeds between release notes. Source: [cnet.com](https://www.cnet.com/videos/new-audible-feature-smartphones-in-space-and-more-tech-today/)

- Apple launches $599 MacBook Neo powered by an iPhone chip - The Verge  
  The Verge covers Apple’s March hardware announcement of the MacBook Neo, which uses an iPhone-class chip — headline-making consumer hardware that shifts expectations for laptop performance and mobile-first silicon. Developers should watch how new hardware affects tooling and local build performance. Source: [theverge.com](https://www.theverge.com/tech/886496/apple-march-2026-event-macbook-neo-announcement)

- MacBook Neo, iPhone 17e: What You Need to Know About Apple's March Event - PCMag  
  PCMag’s event summary walks through Apple’s big reveals — a practical cheat-sheet if you missed the keynote and want the highlights quickly. Again, broadly relevant to devs mainly for how new devices affect testing matrices. Source: [pcmag.com](https://www.pcmag.com/news/apple-march-event-macbook-neo-iphone-17e-m4-ipad-air-everything-to-know)

- Trump says Iran war will be over ‘very soon' - NBC New York  
  A political news clip that landed in aggregated feeds; included here as an example of the non-technical headlines that can distract developer teams and tooling alerts. It’s unrelated to React Native but part of what shows up in the “Static.” Source: [nbcnewyork.com](https://www.nbcnewyork.com/video/news/national-international/trump-says-iran-war-will-be-over-very-soon/6474521/)

- ‘Suspicious devices' found outside Gracie Mansion amid anti-Islam protest - NBC New York  
  Local news coverage about public-safety events that illustrate the wide variety of stories competing for attention in aggregators and newsletters. Not React Native-related, but present in mainstream feeds. Source: [nbcnewyork.com](https://www.nbcnewyork.com/video/news/suspicious-devices-found-outside-gracie-mansion-amid-anti-islam-protest/6473614/)

---

That’s the roundup — engines are changing, Expo keeps extending the developer safety rails, Quest adds a new platform to your matrix, and security reminders are louder than ever. If your CI broke last week, you’re probably not alone; if it didn’t, maybe write a blog post.

Stay curious, ship safely, and may your bundlers be ever fast.

— Shipshape News Team