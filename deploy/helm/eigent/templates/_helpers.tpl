{{/*
Expand the name of the chart.
*/}}
{{- define "eigent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "eigent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "eigent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "eigent.labels" -}}
helm.sh/chart: {{ include "eigent.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Registry labels
*/}}
{{- define "eigent.registry.labels" -}}
{{ include "eigent.labels" . }}
app.kubernetes.io/name: {{ include "eigent.name" . }}-registry
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: registry
{{- end }}

{{/*
Registry selector labels
*/}}
{{- define "eigent.registry.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eigent.name" . }}-registry
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Dashboard labels
*/}}
{{- define "eigent.dashboard.labels" -}}
{{ include "eigent.labels" . }}
app.kubernetes.io/name: {{ include "eigent.name" . }}-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: dashboard
{{- end }}

{{/*
Dashboard selector labels
*/}}
{{- define "eigent.dashboard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eigent.name" . }}-dashboard
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
