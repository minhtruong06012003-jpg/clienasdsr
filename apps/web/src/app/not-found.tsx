import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getServerI18n } from "@/lib/i18n/server";

/** Trang 404 */
export default async function NotFound() {
  const { t } = await getServerI18n();
  return (
    <div className="bg-hero flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-gradient text-7xl font-bold">404</p>
      <h1 className="text-2xl font-semibold">{t("Không tìm thấy trang")}</h1>
      <p className="max-w-md text-muted-foreground">{t("Trang bạn tìm không tồn tại hoặc đã bị di chuyển.")}</p>
      <Button asChild size="lg">
        <Link href="/">{t("Về trang chủ")}</Link>
      </Button>
    </div>
  );
}
