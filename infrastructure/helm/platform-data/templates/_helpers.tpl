{{/*
Common labels. Usage: {{ include "platform-data.labels" (dict "root" $ "name" "redis") }}
*/}}
{{- define "platform-data.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: platform-lab
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end -}}

{{/*
Selector labels, kept separate from platform-data.labels because selectors are immutable on update.
*/}}
{{- define "platform-data.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: platform-lab
{{- end -}}
