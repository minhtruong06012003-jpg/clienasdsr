import type { ContentTypeOrder, ContentTypeSupport, FieldGroupDef, TypeLabels } from '@cmsnt/shared';

/**
 * Mẫu loại nội dung có sẵn — cài 1 chạm trong admin (Loại nội dung › Mẫu có sẵn).
 * Mỗi mẫu gồm: loại nội dung + taxonomy liên quan + nhóm trường tuỳ chỉnh (entity "entry").
 * Cài idempotent: phần nào đã có (trùng key) thì bỏ qua. Khách có thể sửa lại sau khi cài.
 */
export interface ContentTypePresetTaxonomy {
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  hierarchical: boolean;
  isPublic?: boolean;
  showInFilter?: boolean;
  /** term mẫu (tên theo vi / en) tạo khi taxonomy mới được tạo */
  terms?: { vi: string; en: string }[];
}

export interface ContentTypePreset {
  key: string;
  /** nhãn hiển thị trong danh sách mẫu */
  label: string;
  description: string;
  icon: string;
  type: {
    labels: TypeLabels;
    slugs: Record<string, string>;
    description: string;
    supports: ContentTypeSupport[];
    isPublic: boolean;
    hasArchive: boolean;
    searchable: boolean;
    perPage: number;
    orderBy: ContentTypeOrder;
    listColumns: string[];
  };
  taxonomies: ContentTypePresetTaxonomy[];
  fieldGroups: FieldGroupDef[];
}

const L = (viS: string, viP: string, enS: string, enP: string): TypeLabels => ({ vi: { singular: viS, plural: viP }, en: { singular: enS, plural: enP } });

const BASIC: ContentTypeSupport[] = ['editor', 'excerpt', 'featuredImage', 'revisions', 'featured'];

export const CONTENT_TYPE_PRESETS: ContentTypePreset[] = [
  // ------------------------------------------------------------------ Dự án
  {
    key: 'project',
    label: 'Dự án',
    description: 'Dự án đã / đang thực hiện: khách hàng, địa điểm, quy mô, thời gian, trạng thái, bộ ảnh. Hợp với công ty xây dựng, nội thất, agency.',
    icon: 'briefcase',
    type: {
      labels: L('Dự án', 'Dự án', 'Project', 'Projects'),
      slugs: { vi: 'du-an', en: 'projects' },
      description: 'Các dự án tiêu biểu',
      supports: [...BASIC, 'blocks', 'order'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'publishedAt_desc',
      listColumns: ['client', 'status'],
    },
    taxonomies: [
      {
        key: 'project_category',
        labels: L('Lĩnh vực', 'Lĩnh vực', 'Field', 'Fields'),
        slugs: { vi: 'linh-vuc-du-an', en: 'project-fields' },
        hierarchical: true,
        terms: [
          { vi: 'Nhà ở', en: 'Residential' },
          { vi: 'Thương mại', en: 'Commercial' },
          { vi: 'Công nghiệp', en: 'Industrial' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_project_info',
        name: 'Thông tin dự án',
        entity: 'entry',
        rules: { contentTypes: ['project'] },
        placement: 'main',
        fields: [
          { key: 'client', label: 'Khách hàng / Chủ đầu tư', type: 'text', width: 'half' },
          { key: 'location', label: 'Địa điểm', type: 'text', i18n: true, width: 'half' },
          { key: 'scale', label: 'Quy mô', type: 'text', i18n: true, width: 'half', placeholder: '12.000 m²' },
          { key: 'budget', label: 'Giá trị hợp đồng (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'start_date', label: 'Ngày bắt đầu', type: 'date', width: 'half' },
          { key: 'end_date', label: 'Ngày hoàn thành', type: 'date', width: 'half' },
          {
            key: 'status',
            label: 'Trạng thái',
            type: 'select',
            width: 'half',
            default: 'completed',
            options: [
              { value: 'planning', label: 'Đang lên kế hoạch' },
              { value: 'in_progress', label: 'Đang thi công' },
              { value: 'completed', label: 'Đã hoàn thành' },
            ],
          },
          { key: 'website', label: 'Website dự án', type: 'url', width: 'half' },
          { key: 'gallery', label: 'Bộ ảnh dự án', type: 'gallery' },
          { key: 'highlights', label: 'Điểm nổi bật', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Nội dung', type: 'text', i18n: true }] },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Dịch vụ
  {
    key: 'service',
    label: 'Dịch vụ',
    description: 'Trang dịch vụ: giá tham khảo, thời gian thực hiện, quy trình, câu hỏi thường gặp, nút liên hệ.',
    icon: 'handshake',
    type: {
      labels: L('Dịch vụ', 'Dịch vụ', 'Service', 'Services'),
      slugs: { vi: 'dich-vu', en: 'services' },
      description: 'Các dịch vụ cung cấp',
      supports: [...BASIC, 'blocks', 'order', 'hierarchical'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'sortOrder_asc',
      listColumns: ['price_from'],
    },
    taxonomies: [
      {
        key: 'service_category',
        labels: L('Nhóm dịch vụ', 'Nhóm dịch vụ', 'Service group', 'Service groups'),
        slugs: { vi: 'nhom-dich-vu', en: 'service-groups' },
        hierarchical: true,
      },
    ],
    fieldGroups: [
      {
        key: 'entry_service_info',
        name: 'Thông tin dịch vụ',
        entity: 'entry',
        rules: { contentTypes: ['service'] },
        placement: 'main',
        fields: [
          { key: 'icon', label: 'Biểu tượng (ảnh nhỏ)', type: 'image', width: 'half' },
          { key: 'price_from', label: 'Giá từ (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'price_unit', label: 'Đơn vị giá', type: 'text', i18n: true, width: 'half', placeholder: '/ tháng' },
          { key: 'duration', label: 'Thời gian thực hiện', type: 'text', i18n: true, width: 'half', placeholder: '3–5 ngày' },
          { key: 'features', label: 'Hạng mục bao gồm', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Hạng mục', type: 'text', i18n: true }] },
          {
            key: 'process',
            label: 'Quy trình',
            type: 'repeater',
            itemLabelField: 'title',
            fields: [
              { key: 'title', label: 'Bước', type: 'text', i18n: true },
              { key: 'description', label: 'Mô tả', type: 'textarea', i18n: true },
            ],
          },
          {
            key: 'faqs',
            label: 'Câu hỏi thường gặp',
            type: 'repeater',
            itemLabelField: 'question',
            fields: [
              { key: 'question', label: 'Câu hỏi', type: 'text', i18n: true },
              { key: 'answer', label: 'Trả lời', type: 'textarea', i18n: true },
            ],
          },
          { key: 'cta', label: 'Nút kêu gọi', type: 'link', i18n: true },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Tuyển dụng
  {
    key: 'job',
    label: 'Tuyển dụng',
    description: 'Tin tuyển dụng: mức lương, địa điểm, hình thức, hạn nộp, số lượng, quyền lợi, yêu cầu, cách ứng tuyển.',
    icon: 'user-search',
    type: {
      labels: L('Tin tuyển dụng', 'Tuyển dụng', 'Job', 'Careers'),
      slugs: { vi: 'tuyen-dung', en: 'careers' },
      description: 'Vị trí đang tuyển',
      supports: ['editor', 'excerpt', 'featuredImage', 'revisions', 'featured'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 20,
      orderBy: 'publishedAt_desc',
      listColumns: ['location', 'deadline'],
    },
    taxonomies: [
      {
        key: 'job_department',
        labels: L('Phòng ban', 'Phòng ban', 'Department', 'Departments'),
        slugs: { vi: 'phong-ban', en: 'departments' },
        hierarchical: true,
        terms: [
          { vi: 'Kinh doanh', en: 'Sales' },
          { vi: 'Kỹ thuật', en: 'Engineering' },
          { vi: 'Marketing', en: 'Marketing' },
        ],
      },
      {
        key: 'job_location',
        labels: L('Nơi làm việc', 'Nơi làm việc', 'Location', 'Locations'),
        slugs: { vi: 'noi-lam-viec', en: 'job-locations' },
        hierarchical: false,
        terms: [
          { vi: 'Hà Nội', en: 'Hanoi' },
          { vi: 'TP. Hồ Chí Minh', en: 'Ho Chi Minh City' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_job_info',
        name: 'Thông tin tuyển dụng',
        entity: 'entry',
        rules: { contentTypes: ['job'] },
        placement: 'main',
        fields: [
          { key: 'salary_from', label: 'Lương từ (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'salary_to', label: 'Lương đến (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'salary_negotiable', label: 'Lương thoả thuận', type: 'boolean', default: false, width: 'half' },
          { key: 'location', label: 'Địa điểm làm việc', type: 'text', i18n: true, width: 'half' },
          {
            key: 'job_type',
            label: 'Hình thức',
            type: 'select',
            width: 'half',
            default: 'full_time',
            options: [
              { value: 'full_time', label: 'Toàn thời gian' },
              { value: 'part_time', label: 'Bán thời gian' },
              { value: 'internship', label: 'Thực tập' },
              { value: 'remote', label: 'Làm từ xa' },
              { value: 'contract', label: 'Hợp đồng / Freelance' },
            ],
          },
          {
            key: 'level',
            label: 'Cấp bậc',
            type: 'select',
            width: 'half',
            options: [
              { value: 'intern', label: 'Thực tập sinh' },
              { value: 'junior', label: 'Nhân viên' },
              { value: 'senior', label: 'Chuyên viên' },
              { value: 'lead', label: 'Trưởng nhóm' },
              { value: 'manager', label: 'Quản lý' },
            ],
          },
          { key: 'quantity', label: 'Số lượng tuyển', type: 'number', min: 1, width: 'half' },
          { key: 'deadline', label: 'Hạn nộp hồ sơ', type: 'date', width: 'half' },
          { key: 'experience', label: 'Kinh nghiệm', type: 'text', i18n: true, width: 'half', placeholder: '1–2 năm' },
          { key: 'apply_email', label: 'Email nhận hồ sơ', type: 'email', width: 'half' },
          { key: 'requirements', label: 'Yêu cầu ứng viên', type: 'richtext', i18n: true, rows: 6 },
          { key: 'benefits', label: 'Quyền lợi', type: 'richtext', i18n: true, rows: 6 },
          { key: 'apply_link', label: 'Link ứng tuyển', type: 'link', i18n: true },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Khoá học
  {
    key: 'course',
    label: 'Khoá học',
    description: 'Khoá học (không bán qua giỏ hàng): giảng viên, thời lượng, học phí, lịch khai giảng, hình thức, chương trình học.',
    icon: 'graduation-cap',
    type: {
      labels: L('Khoá học', 'Khoá học', 'Course', 'Courses'),
      slugs: { vi: 'khoa-hoc', en: 'courses' },
      description: 'Các khoá học',
      supports: [...BASIC, 'blocks', 'author'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'publishedAt_desc',
      listColumns: ['fee', 'start_date'],
    },
    taxonomies: [
      {
        key: 'course_topic',
        labels: L('Chủ đề', 'Chủ đề', 'Topic', 'Topics'),
        slugs: { vi: 'chu-de-khoa-hoc', en: 'course-topics' },
        hierarchical: true,
      },
      {
        key: 'course_level',
        labels: L('Trình độ', 'Trình độ', 'Level', 'Levels'),
        slugs: { vi: 'trinh-do', en: 'levels' },
        hierarchical: false,
        terms: [
          { vi: 'Cơ bản', en: 'Beginner' },
          { vi: 'Trung cấp', en: 'Intermediate' },
          { vi: 'Nâng cao', en: 'Advanced' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_course_info',
        name: 'Thông tin khoá học',
        entity: 'entry',
        rules: { contentTypes: ['course'] },
        placement: 'main',
        fields: [
          { key: 'instructor', label: 'Giảng viên', type: 'text', width: 'half' },
          { key: 'instructor_photo', label: 'Ảnh giảng viên', type: 'image', width: 'half' },
          { key: 'fee', label: 'Học phí (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'sale_fee', label: 'Học phí ưu đãi (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'duration', label: 'Thời lượng', type: 'text', i18n: true, width: 'half', placeholder: '12 buổi' },
          { key: 'start_date', label: 'Ngày khai giảng', type: 'date', width: 'half' },
          {
            key: 'mode',
            label: 'Hình thức học',
            type: 'select',
            width: 'half',
            default: 'online',
            options: [
              { value: 'online', label: 'Trực tuyến' },
              { value: 'offline', label: 'Tại lớp' },
              { value: 'hybrid', label: 'Kết hợp' },
            ],
          },
          { key: 'schedule', label: 'Lịch học', type: 'text', i18n: true, width: 'half', placeholder: 'Tối thứ 2-4-6' },
          { key: 'intro_video', label: 'Video giới thiệu (URL)', type: 'url' },
          {
            key: 'curriculum',
            label: 'Chương trình học',
            type: 'repeater',
            itemLabelField: 'title',
            fields: [
              { key: 'title', label: 'Bài / chương', type: 'text', i18n: true },
              { key: 'description', label: 'Nội dung', type: 'textarea', i18n: true },
            ],
          },
          { key: 'register_link', label: 'Nút đăng ký', type: 'link', i18n: true },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Bất động sản
  {
    key: 'real_estate',
    label: 'Bất động sản',
    description: 'Tin bất động sản: giá, diện tích, địa chỉ, phòng ngủ, phòng tắm, hướng, pháp lý, bộ ảnh, bản đồ.',
    icon: 'building-2',
    type: {
      labels: L('Bất động sản', 'Bất động sản', 'Property', 'Properties'),
      slugs: { vi: 'bat-dong-san', en: 'properties' },
      description: 'Tin mua bán / cho thuê bất động sản',
      supports: ['editor', 'excerpt', 'featuredImage', 'revisions', 'featured', 'author'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'publishedAt_desc',
      listColumns: ['price', 'area'],
    },
    taxonomies: [
      {
        key: 'property_type',
        labels: L('Loại hình', 'Loại hình', 'Property type', 'Property types'),
        slugs: { vi: 'loai-hinh', en: 'property-types' },
        hierarchical: true,
        terms: [
          { vi: 'Căn hộ chung cư', en: 'Apartment' },
          { vi: 'Nhà phố', en: 'Townhouse' },
          { vi: 'Biệt thự', en: 'Villa' },
          { vi: 'Đất nền', en: 'Land' },
        ],
      },
      {
        key: 'property_area',
        labels: L('Khu vực', 'Khu vực', 'Area', 'Areas'),
        slugs: { vi: 'khu-vuc', en: 'areas' },
        hierarchical: true,
        terms: [
          { vi: 'Hà Nội', en: 'Hanoi' },
          { vi: 'TP. Hồ Chí Minh', en: 'Ho Chi Minh City' },
          { vi: 'Đà Nẵng', en: 'Da Nang' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_real_estate_info',
        name: 'Thông tin bất động sản',
        entity: 'entry',
        rules: { contentTypes: ['real_estate'] },
        placement: 'main',
        fields: [
          {
            key: 'listing_type',
            label: 'Hình thức',
            type: 'select',
            width: 'half',
            default: 'sale',
            options: [
              { value: 'sale', label: 'Bán' },
              { value: 'rent', label: 'Cho thuê' },
            ],
          },
          { key: 'price', label: 'Giá (VNĐ)', type: 'number', min: 0, width: 'half' },
          { key: 'price_note', label: 'Ghi chú giá', type: 'text', i18n: true, width: 'half', placeholder: 'Thoả thuận / tháng' },
          { key: 'area', label: 'Diện tích (m²)', type: 'number', min: 0, step: 0.1, width: 'half' },
          { key: 'address', label: 'Địa chỉ', type: 'text', i18n: true },
          { key: 'bedrooms', label: 'Phòng ngủ', type: 'number', min: 0, width: 'half' },
          { key: 'bathrooms', label: 'Phòng tắm', type: 'number', min: 0, width: 'half' },
          { key: 'floors', label: 'Số tầng', type: 'number', min: 0, width: 'half' },
          {
            key: 'direction',
            label: 'Hướng',
            type: 'select',
            width: 'half',
            options: [
              { value: 'east', label: 'Đông' },
              { value: 'west', label: 'Tây' },
              { value: 'south', label: 'Nam' },
              { value: 'north', label: 'Bắc' },
              { value: 'north_east', label: 'Đông Bắc' },
              { value: 'north_west', label: 'Tây Bắc' },
              { value: 'south_east', label: 'Đông Nam' },
              { value: 'south_west', label: 'Tây Nam' },
            ],
          },
          {
            key: 'legal',
            label: 'Pháp lý',
            type: 'select',
            width: 'half',
            options: [
              { value: 'red_book', label: 'Sổ đỏ / Sổ hồng' },
              { value: 'contract', label: 'Hợp đồng mua bán' },
              { value: 'pending', label: 'Đang chờ sổ' },
            ],
          },
          { key: 'amenities', label: 'Tiện ích', type: 'multiselect', options: [
            { value: 'parking', label: 'Chỗ đậu xe' },
            { value: 'pool', label: 'Hồ bơi' },
            { value: 'gym', label: 'Phòng gym' },
            { value: 'elevator', label: 'Thang máy' },
            { value: 'security', label: 'Bảo vệ 24/7' },
            { value: 'furnished', label: 'Đầy đủ nội thất' },
          ] },
          { key: 'gallery', label: 'Bộ ảnh', type: 'gallery' },
          { key: 'map_embed', label: 'Bản đồ (link Google Maps nhúng)', type: 'url', help: 'Dán link "Nhúng bản đồ" (https://www.google.com/maps/embed?...)' },
          { key: 'contact_name', label: 'Người liên hệ', type: 'text', width: 'half' },
          { key: 'contact_phone', label: 'Số điện thoại', type: 'text', width: 'half' },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Sự kiện
  {
    key: 'event',
    label: 'Sự kiện',
    description: 'Sự kiện / hội thảo: thời gian bắt đầu – kết thúc, địa điểm, hình thức, phí tham dự, link đăng ký, diễn giả.',
    icon: 'calendar-days',
    type: {
      labels: L('Sự kiện', 'Sự kiện', 'Event', 'Events'),
      slugs: { vi: 'su-kien', en: 'events' },
      description: 'Sự kiện sắp diễn ra và đã diễn ra',
      supports: [...BASIC, 'blocks'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'publishedAt_desc',
      listColumns: ['start_at', 'venue'],
    },
    taxonomies: [
      {
        key: 'event_category',
        labels: L('Loại sự kiện', 'Loại sự kiện', 'Event type', 'Event types'),
        slugs: { vi: 'loai-su-kien', en: 'event-types' },
        hierarchical: true,
        terms: [
          { vi: 'Hội thảo', en: 'Seminar' },
          { vi: 'Workshop', en: 'Workshop' },
          { vi: 'Webinar', en: 'Webinar' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_event_info',
        name: 'Thông tin sự kiện',
        entity: 'entry',
        rules: { contentTypes: ['event'] },
        placement: 'main',
        fields: [
          { key: 'start_at', label: 'Bắt đầu', type: 'datetime', width: 'half', required: true },
          { key: 'end_at', label: 'Kết thúc', type: 'datetime', width: 'half' },
          {
            key: 'mode',
            label: 'Hình thức',
            type: 'select',
            width: 'half',
            default: 'offline',
            options: [
              { value: 'offline', label: 'Trực tiếp' },
              { value: 'online', label: 'Trực tuyến' },
              { value: 'hybrid', label: 'Kết hợp' },
            ],
          },
          { key: 'fee', label: 'Phí tham dự (VNĐ, 0 = miễn phí)', type: 'number', min: 0, width: 'half' },
          { key: 'venue', label: 'Địa điểm', type: 'text', i18n: true },
          { key: 'map_embed', label: 'Bản đồ (link nhúng)', type: 'url' },
          { key: 'capacity', label: 'Số chỗ', type: 'number', min: 0, width: 'half' },
          { key: 'organizer', label: 'Đơn vị tổ chức', type: 'text', width: 'half' },
          {
            key: 'speakers',
            label: 'Diễn giả',
            type: 'repeater',
            itemLabelField: 'name',
            fields: [
              { key: 'name', label: 'Họ tên', type: 'text' },
              { key: 'title', label: 'Chức danh', type: 'text', i18n: true },
              { key: 'photo', label: 'Ảnh', type: 'image' },
            ],
          },
          { key: 'register_link', label: 'Nút đăng ký', type: 'link', i18n: true },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Đội ngũ
  {
    key: 'team',
    label: 'Đội ngũ',
    description: 'Thành viên đội ngũ / ban lãnh đạo / bác sĩ / giảng viên: chức danh, liên hệ, mạng xã hội, chuyên môn.',
    icon: 'users',
    type: {
      labels: L('Thành viên', 'Đội ngũ', 'Team member', 'Team'),
      slugs: { vi: 'doi-ngu', en: 'team' },
      description: 'Giới thiệu đội ngũ',
      supports: ['editor', 'excerpt', 'featuredImage', 'order'],
      isPublic: true,
      hasArchive: true,
      searchable: false,
      perPage: 24,
      orderBy: 'sortOrder_asc',
      listColumns: ['position'],
    },
    taxonomies: [
      {
        key: 'team_group',
        labels: L('Bộ phận', 'Bộ phận', 'Group', 'Groups'),
        slugs: { vi: 'bo-phan', en: 'team-groups' },
        hierarchical: true,
        isPublic: false,
        terms: [
          { vi: 'Ban lãnh đạo', en: 'Leadership' },
          { vi: 'Chuyên gia', en: 'Experts' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_team_info',
        name: 'Thông tin thành viên',
        entity: 'entry',
        rules: { contentTypes: ['team'] },
        placement: 'main',
        fields: [
          { key: 'position', label: 'Chức danh', type: 'text', i18n: true, width: 'half', required: true },
          { key: 'experience_years', label: 'Số năm kinh nghiệm', type: 'number', min: 0, width: 'half' },
          { key: 'email', label: 'Email', type: 'email', width: 'half' },
          { key: 'phone', label: 'Điện thoại', type: 'text', width: 'half' },
          { key: 'facebook', label: 'Facebook', type: 'url', width: 'half' },
          { key: 'linkedin', label: 'LinkedIn', type: 'url', width: 'half' },
          { key: 'expertise', label: 'Chuyên môn', type: 'repeater', itemLabelField: 'text', fields: [{ key: 'text', label: 'Lĩnh vực', type: 'text', i18n: true }] },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Cảm nhận khách hàng
  {
    key: 'testimonial',
    label: 'Cảm nhận khách hàng',
    description: 'Đánh giá / cảm nhận của khách hàng để hiển thị trong block (không có trang riêng): tên, chức danh, công ty, số sao.',
    icon: 'quote',
    type: {
      labels: L('Cảm nhận', 'Cảm nhận khách hàng', 'Testimonial', 'Testimonials'),
      slugs: { vi: 'cam-nhan', en: 'testimonials' },
      description: 'Ý kiến khách hàng',
      supports: ['editor', 'featuredImage', 'order', 'featured'],
      isPublic: false,
      hasArchive: false,
      searchable: false,
      perPage: 12,
      orderBy: 'sortOrder_asc',
      listColumns: ['company', 'rating'],
    },
    taxonomies: [],
    fieldGroups: [
      {
        key: 'entry_testimonial_info',
        name: 'Thông tin khách hàng',
        entity: 'entry',
        rules: { contentTypes: ['testimonial'] },
        placement: 'main',
        fields: [
          { key: 'author_title', label: 'Chức danh', type: 'text', i18n: true, width: 'half' },
          { key: 'company', label: 'Công ty', type: 'text', width: 'half' },
          { key: 'rating', label: 'Số sao (1–5)', type: 'number', min: 1, max: 5, default: 5, width: 'half' },
          { key: 'logo', label: 'Logo công ty', type: 'image', width: 'half' },
          { key: 'video', label: 'Video cảm nhận (URL)', type: 'url' },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Hỏi đáp
  {
    key: 'faq',
    label: 'Hỏi đáp',
    description: 'Câu hỏi thường gặp dùng trong block (không có trang riêng): tiêu đề là câu hỏi, nội dung là câu trả lời, nhóm theo chủ đề.',
    icon: 'circle-help',
    type: {
      labels: L('Câu hỏi', 'Hỏi đáp', 'Question', 'FAQ'),
      slugs: { vi: 'hoi-dap', en: 'faq' },
      description: 'Câu hỏi thường gặp',
      supports: ['editor', 'order'],
      isPublic: false,
      hasArchive: false,
      searchable: false,
      perPage: 50,
      orderBy: 'sortOrder_asc',
      listColumns: [],
    },
    taxonomies: [
      {
        key: 'faq_topic',
        labels: L('Chủ đề hỏi đáp', 'Chủ đề hỏi đáp', 'FAQ topic', 'FAQ topics'),
        slugs: { vi: 'chu-de-hoi-dap', en: 'faq-topics' },
        hierarchical: false,
        isPublic: false,
        terms: [
          { vi: 'Chung', en: 'General' },
          { vi: 'Thanh toán', en: 'Payment' },
        ],
      },
    ],
    fieldGroups: [],
  },
  // ------------------------------------------------------------------ Tác phẩm
  {
    key: 'portfolio',
    label: 'Tác phẩm',
    description: 'Portfolio cho studio / nhiếp ảnh / thiết kế: khách hàng, năm, vai trò, công cụ, bộ ảnh, video, link xem.',
    icon: 'palette',
    type: {
      labels: L('Tác phẩm', 'Tác phẩm', 'Work', 'Portfolio'),
      slugs: { vi: 'tac-pham', en: 'portfolio' },
      description: 'Sản phẩm sáng tạo tiêu biểu',
      supports: [...BASIC, 'blocks', 'order'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 12,
      orderBy: 'sortOrder_asc',
      listColumns: ['client', 'year'],
    },
    taxonomies: [
      {
        key: 'portfolio_category',
        labels: L('Thể loại', 'Thể loại', 'Category', 'Categories'),
        slugs: { vi: 'the-loai', en: 'work-categories' },
        hierarchical: true,
        terms: [
          { vi: 'Thiết kế thương hiệu', en: 'Branding' },
          { vi: 'Website', en: 'Website' },
          { vi: 'Nhiếp ảnh', en: 'Photography' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_portfolio_info',
        name: 'Thông tin tác phẩm',
        entity: 'entry',
        rules: { contentTypes: ['portfolio'] },
        placement: 'main',
        fields: [
          { key: 'client', label: 'Khách hàng', type: 'text', width: 'half' },
          { key: 'year', label: 'Năm', type: 'number', min: 1900, max: 2100, width: 'half' },
          { key: 'role', label: 'Vai trò', type: 'text', i18n: true, width: 'half' },
          { key: 'tools', label: 'Công cụ', type: 'text', width: 'half', placeholder: 'Figma, Photoshop' },
          { key: 'gallery', label: 'Bộ ảnh', type: 'gallery' },
          { key: 'video', label: 'Video (URL)', type: 'url', width: 'half' },
          { key: 'live_url', label: 'Link xem', type: 'url', width: 'half' },
          { key: 'accent_color', label: 'Màu chủ đạo', type: 'color', width: 'half' },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Tài liệu tải về
  {
    key: 'document',
    label: 'Tài liệu tải về',
    description: 'Thư viện tài liệu: tệp đính kèm, loại tệp, phiên bản, ngày ban hành, số hiệu văn bản.',
    icon: 'file-down',
    type: {
      labels: L('Tài liệu', 'Tài liệu', 'Document', 'Documents'),
      slugs: { vi: 'tai-lieu', en: 'documents' },
      description: 'Tài liệu, biểu mẫu, văn bản tải về',
      supports: ['editor', 'excerpt', 'featuredImage', 'revisions'],
      isPublic: true,
      hasArchive: true,
      searchable: true,
      perPage: 20,
      orderBy: 'publishedAt_desc',
      listColumns: ['doc_number', 'issued_date'],
    },
    taxonomies: [
      {
        key: 'document_category',
        labels: L('Loại tài liệu', 'Loại tài liệu', 'Document type', 'Document types'),
        slugs: { vi: 'loai-tai-lieu', en: 'document-types' },
        hierarchical: true,
        terms: [
          { vi: 'Biểu mẫu', en: 'Forms' },
          { vi: 'Hướng dẫn', en: 'Guides' },
          { vi: 'Văn bản pháp lý', en: 'Legal documents' },
        ],
      },
    ],
    fieldGroups: [
      {
        key: 'entry_document_info',
        name: 'Thông tin tài liệu',
        entity: 'entry',
        rules: { contentTypes: ['document'] },
        placement: 'main',
        fields: [
          { key: 'file', label: 'Tệp tài liệu', type: 'file', required: true },
          { key: 'doc_number', label: 'Số hiệu', type: 'text', width: 'half' },
          { key: 'version', label: 'Phiên bản', type: 'text', width: 'half' },
          { key: 'issued_date', label: 'Ngày ban hành', type: 'date', width: 'half' },
          { key: 'issuer', label: 'Cơ quan / người ban hành', type: 'text', width: 'half' },
          { key: 'external_url', label: 'Link tải ngoài (nếu không đính kèm)', type: 'url' },
        ],
      },
    ],
  },
];
