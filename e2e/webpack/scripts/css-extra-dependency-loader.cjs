module.exports = function cssExtraDependencyLoader(source) {
  const { dependency } = this.getOptions();
  this.addDependency(dependency);
  return source;
};
