import { useTranslation } from 'react-i18next';
import FileList from './FileList.jsx';
import { FileApi } from '../api/endpoints.js';

export default function Recent() {
  const { t } = useTranslation();
  return (
    <FileList
      title={t('recent.title')}
      emptyText={t('recent.empty')}
      queryKey={['file-recent']}
      queryFn={() => FileApi.recent()}
    />
  );
}
