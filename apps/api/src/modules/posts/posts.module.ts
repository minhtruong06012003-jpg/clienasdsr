import { Module } from '@nestjs/common';
import { PostsController, PublicPostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';
import { PostTermsService } from './terms.service.js';

@Module({ controllers: [PostsController, PublicPostsController], providers: [PostsService, PostTermsService], exports: [PostsService, PostTermsService] })
export class PostsModule {}
