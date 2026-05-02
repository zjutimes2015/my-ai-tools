import Link from 'next/link';

import { Button } from '@/shared/components/ui/button';

export function BuiltWith() {
  return (
    <Button asChild variant="outline" size="sm" className="hover:bg-primary/10">
      <Link href="/" target="_self">
        Built with ❤️ 我的 AI 工具站
      </Link>
    </Button>
  );
}
