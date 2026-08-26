export default {
  footer: {
    component: null,
  },
  logo: <span>WyW-in-JS</span>,
  primaryHue: 210,
  primarySaturation: 100,
  docsRepositoryBase:
    'https://github.com/wyw-in-js/wyw-in-js/tree/main/apps/website',
  project: {
    link: 'https://github.com/wyw-in-js/wyw-in-js',
  },
  useNextSeoProps() {
    return {
      titleTemplate: '%s – WyW-in-JS',
    };
  },
};
