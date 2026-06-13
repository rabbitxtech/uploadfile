import { useTranslation } from 'react-i18next';
import FileList from './FileList.jsx';
import { FileApi } from '../api/endpoints.js';

export default function Starred() {
  const { t } = useTranslation();
  return (
    <FileList
      title={t('starred.title')}
      emptyText={t('starred.empty')}
      queryKey={['file-starred']}
      queryFn={() => FileApi.starred()}
    />
  );
}
