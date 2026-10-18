// Точка входа для Yandex Cloud Functions (нужен CommonJS: module.exports.handler).
// Сам код сайта — ES-модули, поэтому подгружаем их через import().
let app;

module.exports.handler = async (event, context) => {
  app ||= await import('./app/handler.mjs');
  return app.handle(event, context);
};
