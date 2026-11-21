import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { CommentsModule } from '../comments/comments.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';

// Comments / Reviews: tính lại số bình luận và điểm đánh giá khi xoá thành viên kèm dữ liệu
@Module({ imports: [CommentsModule, ReviewsModule], controllers: [UsersController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
