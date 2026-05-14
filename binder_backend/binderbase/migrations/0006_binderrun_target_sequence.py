from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('binderbase', '0005_alter_binder_options_alter_binderrun_options_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='binderrun',
            name='target_sequence',
            field=models.TextField(blank=True, null=True),
        ),
    ]
