import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config.service';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
}

async function bootstrap() {
  // rawBody is required: webhook signatures are computed over the exact bytes Cashfree sent.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('UMS Payments (Cashfree)')
      .setDescription('Payment module for the University Management System')
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(app.get(AppConfig).get('PORT'));
}

if (require.main === module) {
  void bootstrap();
}
