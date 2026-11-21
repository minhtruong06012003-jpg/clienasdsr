import { Module } from '@nestjs/common';
import { PagesController, PublicPagesController } from './pages.controller.js';
import { PagesService } from './pages.service.js';

@Module({ controllers: [PagesController, PublicPagesController], providers: [PagesService], exports: [PagesService] })
export class PagesModule {}
