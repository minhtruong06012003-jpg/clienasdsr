import { Global, Module } from '@nestjs/common';
import { LanguagesController } from './languages.controller.js';
import { LanguagesService } from './languages.service.js';

@Global()
@Module({ controllers: [LanguagesController], providers: [LanguagesService], exports: [LanguagesService] })
export class LanguagesModule {}
