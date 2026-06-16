import {
    Controller,
    Post,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { AdminGuard } from '../../common/guards/admin.guard';
import { UploadService } from './upload.service';
import {
    imageFileFilter,
    MAX_UPLOAD_SIZE_BYTES,
    normalizeUploadFilename,
} from './upload.util';

@Controller('upload')
export class UploadController {
    constructor(
        private readonly uploadService: UploadService,
    ) { }

    @Post()
    @ApiBearerAuth()
    @UseGuards(AdminGuard)
    @UseInterceptors(
        FileInterceptor('file', {
            storage: diskStorage({
                destination: './uploads',
                filename: (req, file, cb) => {
                    cb(null, normalizeUploadFilename(file.originalname));
                },
            }),
            fileFilter: imageFileFilter,
            limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
        }),
    )
    uploadFile(
        @UploadedFile() file: Express.Multer.File,
    ) {
        return {
            success: true,
            url: this.uploadService.getFileUrl(
                file.filename,
            ),
        };
    }
}