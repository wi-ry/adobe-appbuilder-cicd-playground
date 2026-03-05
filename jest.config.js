module.exports = {
  preset: null,
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.js$': ['babel-jest', { presets: ['@babel/preset-env'] }],
  },
};